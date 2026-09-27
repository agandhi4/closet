import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import {
  type IncomingMessage,
  request as httpRequest,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Logger } from '../../logger';
import { isPublicAddress } from './public-address';

/**
 * The only way the server fetches anything from the internet: a URL a user
 * supplied (the link import, issue #6; docs/plans/2026-09-26-wardrobe-features.md,
 * section 0) and the weather's fixed API (#14, src/web/weather/open-meteo.ts,
 * which names its hosts in `FetchRequest.hosts`). The server sits on the
 * homelab LAN, so a URL is a way to make it connect to the NAS, pgvault or
 * the router (SSRF). Every fetch:
 *
 * - takes http(s) on the default port only, never with credentials in the URL,
 *   and, when the request names `hosts`, only those hosts (redirects too);
 * - resolves the name once and refuses it if any answer is not a public
 *   address (public-address.ts), then connects to the checked address
 *   (`pinnedLookup`): the socket never resolves the name again, so DNS
 *   rebinding cannot swap the address between the check and the connect.
 *   TLS still gets the name for SNI and certificate checks, and Host is the
 *   name;
 * - follows at most MAX_REDIRECTS redirects, each checked like the first;
 * - is bounded as a whole by one timeout (DNS, connects, redirects, body);
 * - reads the body only for a content type the caller accepts, and stops
 *   reading the moment the decoded bytes pass the cap for that type;
 * - sends no cookie or credentials and keeps none between hops;
 * - logs one line naming the host(s), never the path or query (a product
 *   link can carry a tracking or session token).
 *
 * Failures are `OutboundFetchError`s whose `reason` says which rule refused.
 * The per-user rate limit is the caller's (the route's), not this module's.
 */

export type ContentKind = 'html' | 'image' | 'json';

/** Per content kind, the most decoded bytes read before the fetch is refused. */
export const BYTE_LIMITS: Readonly<Record<ContentKind, number>> = {
  html: 2 * 1024 * 1024,
  image: 15 * 1024 * 1024,
  // An API answer: a 16-day hourly forecast is about 40 KB.
  json: 512 * 1024,
};
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 10_000;
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
  | 'unexpected-content-type'
  | 'too-large'
  | 'timeout'
  | 'network';

export class OutboundFetchError extends Error {
  constructor(
    readonly reason: OutboundFetchRefusal,
    message: string,
    /** The final response's status, for `http-status`. */
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
}

export interface FetchedResource {
  kind: ContentKind;
  /** The content type without parameters, lower case (`image/jpeg`). */
  mediaType: string;
  /** The content type's charset parameter, lower case, when it has one. */
  charset: string | null;
  /** The decoded body, at most BYTE_LIMITS[kind] bytes. */
  body: Buffer;
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
export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

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
  timeoutMs?: number;
}

const systemResolve: Resolve = (hostname) =>
  dnsLookup(hostname, { all: true, order: 'verbatim' });

/**
 * The URL's host (an IPv6 literal without brackets) once its scheme, port
 * and lack of credentials pass. Nothing is resolved yet.
 */
function checkedHost(
  url: URL,
  destinations: DestinationPolicy,
  hosts: readonly string[] | undefined,
): string {
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
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/** A checked URL and the one address the socket will connect to. */
interface PinnedTarget {
  url: URL;
  host: string;
  address: ResolvedAddress;
}

export function createOutboundFetcher(
  options: OutboundFetcherOptions,
): OutboundFetcher {
  const {
    logger,
    resolve = systemResolve,
    destinations = PUBLIC_DESTINATIONS,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options;

  /** The URL's destination, checked, with the address to connect to. */
  async function pin(
    url: URL,
    request: FetchRequest,
    signal: AbortSignal,
  ): Promise<PinnedTarget> {
    const host = checkedHost(url, destinations, request.hosts);
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
    return { url, host, address };
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
      const response = await send(target, request.accept, signal);
      const location = response.headers.location;
      if (REDIRECT_STATUSES.has(response.statusCode ?? 0) && location) {
        response.destroy();
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
        ...(await readResponse(response, request.accept, signal)),
        url,
        redirects,
      };
    }
  }

  return {
    async fetch(rawUrl, request) {
      const started = performance.now();
      const timeout = AbortSignal.timeout(timeoutMs);
      const hosts: string[] = [];
      try {
        const url = parseUrl(rawUrl);
        hosts.push(url.hostname);
        const fetched = await fetchFollowing(url, request, timeout, hosts);
        logger.info(
          `Fetched ${fetched.kind} from ${hostChain(hosts)}: ${fetched.body.length} bytes in ${elapsed(started)} ms`,
        );
        return fetched;
      } catch (error) {
        const refusal = asRefusal(error, timeout);
        logger.warn(
          `Outbound fetch refused (${refusal.reason}): ${hostChain(hosts) || 'no host'} after ${elapsed(started)} ms${networkCode(error)}`,
        );
        throw refusal;
      }
    },
  };
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
 * The socket's lookup, answering with the address that was checked and
 * never asking DNS. net.connect asks for every address (`all`) when it may
 * race IPv4 and IPv6 (autoSelectFamily), else for one.
 */
function pinnedLookup({ address, family }: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      const all: LookupAddress[] = [{ address, family }];
      callback(null, all);
    } else {
      callback(null, address, family);
    }
  };
}

function send(
  { url, host, address }: PinnedTarget,
  accept: readonly ContentKind[],
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const secure = url.protocol === 'https:';
  const options: RequestOptions & { servername?: string } = {
    method: 'GET',
    host,
    port: url.port || (secure ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers: {
      'user-agent': USER_AGENT,
      accept: accept.map((kind) => ACCEPT_HEADERS[kind]).join(','),
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en',
    },
    lookup: pinnedLookup(address),
    // A fresh socket per request: a pooled one could carry another pin.
    agent: false,
    signal,
  };
  // SNI and the certificate check use the name, never an IP (Node refuses
  // an IP as servername). The Host header is the name for both schemes.
  if (secure && !isIP(host)) options.servername = host;
  return new Promise((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)(options);
    request.once('response', resolve);
    request.once('error', reject);
    request.end();
  });
}

async function readResponse(
  response: IncomingMessage,
  accept: readonly ContentKind[],
  signal: AbortSignal,
): Promise<Omit<FetchedResource, 'url' | 'redirects'>> {
  try {
    const status = response.statusCode ?? 0;
    if (status < 200 || status > 299) {
      throw new OutboundFetchError(
        'http-status',
        `The site answered ${status}`,
        status,
      );
    }
    const { mediaType, charset } = parseContentType(
      response.headers['content-type'],
    );
    const kind = accept.find((k) => MEDIA_TYPES[k].includes(mediaType));
    if (!kind) {
      throw new OutboundFetchError(
        'unexpected-content-type',
        `Unexpected content type ${mediaType || '(none)'}`,
      );
    }
    const limit = BYTE_LIMITS[kind];
    const declared = Number(response.headers['content-length']);
    if (!response.headers['content-encoding'] && declared > limit) {
      throw tooLarge(limit);
    }
    const body = await readCapped(decoded(response), limit, signal);
    return { kind, mediaType, charset, body };
  } finally {
    response.destroy();
  }
}

/** The body as sent, decompressed; the cap applies to these bytes. */
function decoded(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? 'identity')
    .trim()
    .toLowerCase();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : undefined;
  if (decoder) {
    // Errors on either side destroy both; the reader sees the first.
    return pipeline(response, decoder, () => undefined);
  }
  if (encoding !== 'identity') {
    throw new OutboundFetchError(
      'unexpected-content-type',
      `Unsupported content encoding ${encoding}`,
    );
  }
  return response;
}

async function readCapped(
  stream: Readable,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > limit) throw tooLarge(limit);
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  // The request's abort destroys the response, which can end the stream
  // quietly instead of with an error; a timed-out body is never returned.
  signal.throwIfAborted();
  return Buffer.concat(chunks, total);
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
