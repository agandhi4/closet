import { lookup as dnsLookup } from 'node:dns/promises';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
} from 'node:http';
import { isIP, type Socket } from 'node:net';
import type { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Logger } from '../../logger';
import { dial, type TrustedCertificates } from './outbound-dial';
import { isPublicAddress } from './public-address';

/**
 * The only way the server fetches anything from the internet: a URL a user
 * supplied (the link import, issue #6; docs/plans/2026-09-26-wardrobe-features.md,
 * section 0), the weather's fixed API (#14, src/web/weather/open-meteo.ts,
 * which names its hosts in `FetchRequest.hosts`) and the order mail's JMAP
 * API (#25, src/web/wardrobe/order-mail/jmap.ts, the one caller that sends a
 * credential). The server sits on the
 * homelab LAN, so a URL is a way to make it connect to the NAS, pgvault or
 * the router (SSRF). Every fetch:
 *
 * - takes http(s) on the default port only, never with credentials in the URL,
 *   and, when the request names `hosts`, only those hosts (redirects too);
 * - resolves the name once and refuses it if any answer is not a public
 *   address (public-address.ts), then connects to the checked address
 *   itself (`dial`, outbound-dial.ts, the one place a connection opens):
 *   nothing resolves the name again, so DNS rebinding cannot swap the
 *   address between the check and the connect. TLS still verifies the
 *   certificate against the name, which is the SNI, and Host is the name;
 * - follows at most MAX_REDIRECTS redirects, each checked like the first;
 * - is bounded as a whole by one timeout (DNS, connects, redirects, body);
 * - reads the body only for a content type the caller accepts, and stops
 *   reading the moment the decoded bytes pass the cap for that type: an
 *   image or JSON past it is refused, a page is cut there (`truncated`),
 *   since what a product page says about itself is in its first bytes;
 * - tells a site that refuses automated fetches (`blocked-by-site`: a 403,
 *   a 429, or a bot-protection challenge on any status) from one that
 *   failed (`http-status`), so a caller can say "this shop blocks us";
 *   for a user's URL only (a request naming `hosts` keeps `http-status`);
 * - sends no cookie and keeps none between hops; a credential
 *   (`authorization`) only to a request that names its `hosts`, which then
 *   follows no redirect, so the credential reaches those hosts and nothing
 *   else;
 * - logs one line naming the host(s), never the path or query (a product
 *   link can carry a tracking or session token).
 *
 * Failures are `OutboundFetchError`s whose `reason` says which rule refused.
 * The per-user rate limit is the caller's (the route's), not this module's.
 */

export type ContentKind = 'html' | 'image' | 'json';

/**
 * Per content kind, the most decoded bytes read: past it an image or JSON
 * is refused and a page is cut (#347: a Shopify product page was 3.8 MB of
 * HTML with its JSON-LD and Open Graph tags in the first 110 KB, behind a
 * 2.8 MB size-chart blob in its head, so neither a higher cap nor stopping
 * at `</head>` would have read it).
 */
export const BYTE_LIMITS: Readonly<Record<ContentKind, number>> = {
  html: 2 * 1024 * 1024,
  image: 15 * 1024 * 1024,
  // An API answer: a 16-day hourly forecast is about 40 KB.
  json: 512 * 1024,
};
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2048;

// SVG is left out: it is a document, not a photo, and the photo pipeline
// has no use for it.
const MEDIA_TYPES: Readonly<Record<ContentKind, readonly string[]>> = {
  html: ['text/html', 'application/xhtml+xml'],
  image: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/heic',
    'image/heif',
  ],
  json: ['application/json'],
};
const ACCEPT_HEADERS: Readonly<Record<ContentKind, string>> = {
  html: 'text/html,application/xhtml+xml;q=0.9',
  image: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
  json: 'application/json',
};
const USER_AGENT = 'Mozilla/5.0 (compatible; Closet/1.0; +link import)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/**
 * Statuses a shop's bot protection answers an automated fetch with
 * (#347: Cloudflare's challenge and block pages are 403s, Shopify's
 * storefront limit a 429 with Retry-After). A public product page has no
 * other reason to refuse an anonymous GET.
 */
const BLOCKING_STATUSES = new Set([403, 429]);

export type OutboundFetchRefusal =
  | 'invalid-url'
  | 'unsupported-scheme'
  | 'credentials-in-url'
  | 'port-not-allowed'
  | 'host-not-allowed'
  | 'unresolvable'
  | 'blocked-address'
  | 'too-many-redirects'
  | 'http-status'
  | 'blocked-by-site'
  | 'unexpected-content-type'
  | 'too-large'
  | 'timeout'
  | 'network';

export class OutboundFetchError extends Error {
  constructor(
    readonly reason: OutboundFetchRefusal,
    message: string,
    /** The final response's status, for `http-status` and `blocked-by-site`. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OutboundFetchError';
  }
}

export interface FetchRequest {
  /** What the caller can use; anything else is refused before its body is read. */
  accept: readonly ContentKind[];
  /**
   * A fixed third-party API's allow-list: every hop's host must be one of
   * these (lower case), so a redirect elsewhere is refused before it is
   * resolved. Absent for a user's URL, which may go anywhere public.
   */
  hosts?: readonly string[];
  /**
   * A fixed API's credential, sent as `Authorization`. Only with `hosts`
   * (a programming error otherwise), and such a request follows no
   * redirect: a redirect answer is an `http-status` refusal.
   */
  authorization?: string;
  /**
   * A JSON body, which makes the request a POST. Only with `hosts`, and it
   * follows no redirect either (a redirected POST would drop or resend it).
   */
  json?: unknown;
}

export interface FetchedResource {
  kind: ContentKind;
  /** The content type without parameters, lower case (`image/jpeg`). */
  mediaType: string;
  /** The content type's charset parameter, lower case, when it has one. */
  charset: string | null;
  /** The decoded body, at most BYTE_LIMITS[kind] bytes. */
  body: Buffer;
  /** A page longer than BYTE_LIMITS.html, cut there (never an image or JSON). */
  truncated: boolean;
  /** Where the body came from, after redirects: the base for relative links. */
  url: URL;
  redirects: number;
}

export interface OutboundFetcher {
  fetch(url: string, request: FetchRequest): Promise<FetchedResource>;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** A name's addresses (the system resolver in production). */
type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

/** Which destinations a fetch may connect to. */
export interface DestinationPolicy {
  allowsAddress: (address: string) => boolean;
  allowsPort: (port: number, protocol: 'http:' | 'https:') => boolean;
}

/** Production: public addresses, default ports. */
export const PUBLIC_DESTINATIONS: DestinationPolicy = {
  allowsAddress: isPublicAddress,
  allowsPort: (port, protocol) => port === (protocol === 'https:' ? 443 : 80),
};

export interface OutboundFetcherOptions {
  logger: Logger;
  /** Defaults to the system resolver. The specs script it. */
  resolve?: Resolve;
  /**
   * Defaults to PUBLIC_DESTINATIONS. Only the specs pass another, to reach
   * a loopback alias standing in for the internet on a random port.
   */
  destinations?: DestinationPolicy;
  /**
   * Specs only: the TLS fixture's certificates, trusted instead of the
   * system's. Absent in production, which verifies against Node's roots.
   */
  tls?: TrustedCertificates;
  timeoutMs?: number;
}

/**
 * The specs' stand-in internet, the only options AppOptions passes through
 * (`outboundFetch`, `weather.fetch`, `orderMail.fetch`); production passes
 * none of them.
 */
export type OutboundStandIn = Pick<
  OutboundFetcherOptions,
  'resolve' | 'destinations' | 'tls'
>;

const systemResolve: Resolve = (hostname) =>
  dnsLookup(hostname, { all: true, order: 'verbatim' });

/**
 * The URL's host (an IPv6 literal without brackets) and port once its
 * scheme, port and lack of credentials pass. Nothing is resolved yet.
 */
function checkedHost(
  url: URL,
  destinations: DestinationPolicy,
  hosts: readonly string[] | undefined,
): { host: string; port: number } {
  const protocol = url.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new OutboundFetchError(
      'unsupported-scheme',
      `Only http and https links can be fetched, not ${protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new OutboundFetchError(
      'credentials-in-url',
      'Links with a user name or password are not fetched',
    );
  }
  const port = Number(url.port || (protocol === 'https:' ? 443 : 80));
  if (!destinations.allowsPort(port, protocol)) {
    throw new OutboundFetchError(
      'port-not-allowed',
      `Port ${port} is not fetched`,
    );
  }
  if (hosts && !hosts.includes(url.hostname)) {
    throw new OutboundFetchError(
      'host-not-allowed',
      `${url.hostname} is not one of this fetch's hosts`,
    );
  }
  return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port };
}

/** A checked URL and the one address the socket will connect to. */
interface PinnedTarget {
  url: URL;
  host: string;
  port: number;
  address: ResolvedAddress;
}

/**
 * One response, whatever the protocol spoke it: all the refusal rules and
 * the body readers see (`refuseStatus`, `readResponse`, `decoded`), so each
 * rule has one copy. `headers` are lower case.
 */
interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
  /** Drops the response and its connection; harmless twice. */
  destroy(): void;
}

export function createOutboundFetcher(
  options: OutboundFetcherOptions,
): OutboundFetcher {
  const {
    logger,
    resolve = systemResolve,
    destinations = PUBLIC_DESTINATIONS,
    tls,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options;

  /** The URL's destination, checked, with the address to connect to. */
  async function pin(
    url: URL,
    request: FetchRequest,
    signal: AbortSignal,
  ): Promise<PinnedTarget> {
    const { host, port } = checkedHost(url, destinations, request.hosts);
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolveName(host, signal);
    // Every answer must pass: a name that also points inside the network
    // is refused outright rather than hoping the connect picks the right one.
    if (!addresses.every((a) => destinations.allowsAddress(a.address))) {
      throw new OutboundFetchError(
        'blocked-address',
        `${host} is not on the public internet`,
      );
    }
    // IPv4 first: the container has no IPv6 route.
    const address = addresses.find((a) => a.family === 4) ?? addresses[0];
    return { url, host, port, address };
  }

  /** One request to the target's checked address, on a socket of its own. */
  async function exchange(
    target: PinnedTarget,
    request: FetchRequest,
    signal: AbortSignal,
  ): Promise<Answer> {
    const socket = await dial(
      {
        host: target.host,
        address: target.address.address,
        port: target.port,
        secure: target.url.protocol === 'https:',
      },
      signal,
      tls,
    );
    return sendHttp1(socket, target.url, request, signal);
  }

  async function resolveName(
    host: string,
    signal: AbortSignal,
  ): Promise<ResolvedAddress[]> {
    let addresses: ResolvedAddress[];
    try {
      addresses = await untilAborted(resolve(host), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new OutboundFetchError(
        'unresolvable',
        `${host} could not be resolved`,
      );
    }
    if (addresses.length === 0) {
      throw new OutboundFetchError(
        'unresolvable',
        `${host} could not be resolved`,
      );
    }
    return addresses;
  }

  async function fetchFollowing(
    start: URL,
    request: FetchRequest,
    signal: AbortSignal,
    hosts: string[],
  ): Promise<FetchedResource> {
    let url = start;
    for (let redirects = 0; ; redirects++) {
      const target = await pin(url, request, signal);
      const answer = await exchange(target, request, signal);
      const { status } = answer;
      const location = answer.headers.location;
      if (REDIRECT_STATUSES.has(status) && location) {
        answer.destroy();
        if (carriesCredentialOrBody(request)) {
          throw new OutboundFetchError(
            'http-status',
            `The API answered a redirect (${status}), which is not followed`,
            status,
          );
        }
        if (redirects === MAX_REDIRECTS) {
          throw new OutboundFetchError(
            'too-many-redirects',
            `More than ${MAX_REDIRECTS} redirects`,
          );
        }
        url = parseUrl(location, url);
        hosts.push(url.hostname);
        continue;
      }
      return {
        ...(await readResponse(answer, request, signal)),
        url,
        redirects,
      };
    }
  }

  return {
    async fetch(rawUrl, request) {
      // Outside the refusals: a caller that sends a credential or a body
      // must pin its hosts, or the credential could follow a user's URL.
      if (carriesCredentialOrBody(request) && !request.hosts) {
        throw new Error(
          'An outbound fetch with a credential or a body must name its hosts',
        );
      }
      const started = performance.now();
      const timeout = AbortSignal.timeout(timeoutMs);
      const hosts: string[] = [];
      try {
        const url = parseUrl(rawUrl);
        hosts.push(url.hostname);
        const fetched = await fetchFollowing(url, request, timeout, hosts);
        logger.info(
          `Fetched ${fetched.kind} from ${hostChain(hosts)}: ${fetched.body.length} bytes${fetched.truncated ? ' (cut at the cap)' : ''} in ${elapsed(started)} ms`,
        );
        return fetched;
      } catch (error) {
        const refusal = asRefusal(error, timeout);
        logger.warn(
          `Outbound fetch refused (${refusal.reason}): ${hostChain(hosts) || 'no host'}${refusal.status === undefined ? '' : ` answered ${refusal.status}`} after ${elapsed(started)} ms${networkCode(error)}`,
        );
        throw refusal;
      }
    },
  };
}

function carriesCredentialOrBody(request: FetchRequest): boolean {
  return request.authorization !== undefined || request.json !== undefined;
}

function parseUrl(value: string, base?: URL): URL {
  if (value.length > MAX_URL_LENGTH) {
    throw new OutboundFetchError('invalid-url', 'The link is too long');
  }
  try {
    return new URL(value.trim(), base);
  } catch {
    throw new OutboundFetchError('invalid-url', 'Not a link');
  }
}

/**
 * The request over HTTP/1.1 on `socket`, which `dial` connected: no agent,
 * so nothing is pooled (a pooled socket could carry another hop's pin) and
 * the request asks the server to close. Host is the URL's own (the name,
 * with a port only when it is not the scheme's), set here rather than
 * derived from a connect option.
 */
function sendHttp1(
  socket: Socket,
  url: URL,
  { accept, authorization, json }: FetchRequest,
  signal: AbortSignal,
): Promise<Answer> {
  const body = json === undefined ? undefined : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      method: body === undefined ? 'GET' : 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        'user-agent': USER_AGENT,
        accept: accept.map((kind) => ACCEPT_HEADERS[kind]).join(','),
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en',
        ...(authorization !== undefined && { authorization }),
        ...(body !== undefined && {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        }),
      },
      createConnection: () => socket,
      signal,
    });
    // `on`, not `once`: a second error (a reset after an abort) with no
    // listener would crash the process. A 1xx never reaches 'response'
    // (Node emits it as 'information'), so it is ignored.
    request.on('error', reject);
    request.once('response', (response: IncomingMessage) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        destroy: () => {
          response.destroy();
          socket.destroy();
        },
      });
    });
    request.end(body);
  });
}

async function readResponse(
  answer: Answer,
  { accept, hosts }: FetchRequest,
  signal: AbortSignal,
): Promise<Omit<FetchedResource, 'url' | 'redirects'>> {
  try {
    refuseStatus(answer, hosts);
    const { mediaType, charset } = parseContentType(
      answer.headers['content-type'],
    );
    const kind = accept.find((k) => MEDIA_TYPES[k].includes(mediaType));
    if (!kind) {
      throw new OutboundFetchError(
        'unexpected-content-type',
        `Unexpected content type ${mediaType || '(none)'}`,
      );
    }
    const limit = BYTE_LIMITS[kind];
    const cut = kind === 'html';
    // An early refusal only: the guard is the counted bytes, since a server
    // can declare less than it sends.
    const declared = Number(answer.headers['content-length']);
    if (!cut && !answer.headers['content-encoding'] && declared > limit) {
      throw tooLarge(limit);
    }
    const { body, truncated } = await readCapped(
      decoded(answer),
      limit,
      cut,
      signal,
    );
    return { kind, mediaType, charset, body, truncated };
  } finally {
    answer.destroy();
  }
}

/** Throws unless the answer is a 2xx that is not a bot's challenge. */
function refuseStatus(
  { status, headers }: Answer,
  hosts: FetchRequest['hosts'],
): void {
  // Only a user's URL meets a shop's bot protection; a fixed API's 403 or
  // 429 is its own answer (a token's scope, a quota), told by its status.
  if (!hosts && (BLOCKING_STATUSES.has(status) || isChallenge(headers))) {
    throw new OutboundFetchError(
      'blocked-by-site',
      `The site refused an automated fetch (${status})`,
      status,
    );
  }
  if (status < 200 || status > 299) {
    throw new OutboundFetchError(
      'http-status',
      `The site answered ${status}`,
      status,
    );
  }
}

/**
 * A bot-protection challenge, whatever the status: AWS WAF answers its
 * JavaScript challenge with a 202 and `x-amzn-waf-action: challenge` (or
 * `captcha`), which would otherwise read as a page with nothing on it;
 * Cloudflare marks its challenges `cf-mitigated: challenge`.
 */
function isChallenge(headers: IncomingHttpHeaders): boolean {
  const waf = headerValue(headers['x-amzn-waf-action']);
  return (
    waf === 'challenge' ||
    waf === 'captcha' ||
    headerValue(headers['cf-mitigated']) === 'challenge'
  );
}

function headerValue(value: string | string[] | undefined): string {
  return (typeof value === 'string' ? value : '').trim().toLowerCase();
}

// A Map, not an object literal: the key is a remote server's header, and
// "constructor" must not find Object.prototype's.
const DECODERS = new Map<string, () => Transform>([
  ['gzip', createGunzip],
  ['x-gzip', createGunzip],
  ['deflate', createInflate],
  ['br', createBrotliDecompress],
]);

/** The body as sent, decompressed; the cap applies to these bytes. */
function decoded({ headers, body }: Answer): Readable {
  const encoding = (headers['content-encoding'] ?? 'identity')
    .trim()
    .toLowerCase();
  const decoder = DECODERS.get(encoding)?.();
  if (decoder) {
    // Errors on either side destroy both; the reader sees the first.
    return pipeline(body, decoder, () => undefined);
  }
  if (encoding !== 'identity') {
    throw new OutboundFetchError(
      'unexpected-content-type',
      `Unsupported content encoding ${encoding}`,
    );
  }
  return body;
}

/**
 * The stream's bytes up to `limit`; past it, refused, or with `cut` the
 * first `limit` bytes. Either way nothing past the limit is read: the
 * stream (and the socket under it) is destroyed at once.
 */
async function readCapped(
  stream: Readable,
  limit: number,
  cut: boolean,
  signal: AbortSignal,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      const room = limit - total;
      if (buffer.length > room && !cut) throw tooLarge(limit);
      if (buffer.length > room) {
        chunks.push(buffer.subarray(0, room));
        total = limit;
        truncated = true;
        break;
      }
      total += buffer.length;
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  // The request's abort destroys the response, which can end the stream
  // quietly instead of with an error; a timed-out body is never returned.
  signal.throwIfAborted();
  return { body: Buffer.concat(chunks, total), truncated };
}

function tooLarge(limit: number): OutboundFetchError {
  return new OutboundFetchError(
    'too-large',
    `Larger than ${Math.round(limit / 1024 / 1024)} MB`,
  );
}

function parseContentType(header: string | undefined): {
  mediaType: string;
  charset: string | null;
} {
  const [type = '', ...parameters] = (header ?? '').split(';');
  const charset = parameters
    .map((parameter) => /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(parameter))
    .find((match) => match !== null);
  return {
    mediaType: type.trim().toLowerCase(),
    charset: charset ? charset[1].toLowerCase() : null,
  };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function asRefusal(error: unknown, timeout: AbortSignal): OutboundFetchError {
  if (error instanceof OutboundFetchError) return error;
  if (timeout.aborted) {
    return new OutboundFetchError('timeout', 'The site took too long');
  }
  return new OutboundFetchError('network', 'The site could not be reached');
}

/** A socket error's code (ECONNREFUSED, ...) for the log; never its message. */
function networkCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof OutboundFetchError || typeof code !== 'string'
    ? ''
    : ` (${code})`;
}

/** `shop.example -> cdn.example`: each host once per run of redirects to it. */
function hostChain(hosts: readonly string[]): string {
  return hosts.filter((host, i) => host && host !== hosts[i - 1]).join(' -> ');
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
