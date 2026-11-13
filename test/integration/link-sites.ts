import { createServer, type RequestListener, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { TLSSocket } from 'node:tls';
import sharp from 'sharp';
import type { AppOptions } from '../../src/app';
import { isPublicAddress } from '../../src/web/security/public-address';
import type {
  DestinationPolicy,
  ResolvedAddress,
} from '../../src/web/security/outbound-fetch';
import { selfSignedCertificate } from '../support/tls-certificate';

/**
 * A shop on the "internet" for the link import's specs, the way
 * outbound-fetch.spec.ts builds one: an HTTP server on the loopback alias
 * 127.0.0.2 (Linux routes all of 127/8 to lo; macOS needs
 * `sudo ifconfig lo0 alias 127.0.0.2`), reached as `shop.test` through a
 * scripted resolver (and as `www.shop.test`, the same server) and a
 * destination policy that admits that one address on any port. Everything else keeps the production rules: `intranet.test`
 * resolves to 127.0.0.1 and must be refused, like any private address; an
 * unknown name does not resolve. Hand `outboundFetch` to createTestApp.
 *
 * The same pages are served over TLS too (`secureUrl`), with a throwaway
 * certificate for both names that the fetcher trusts only through
 * `outboundFetch.tls` (#496a): never NODE_TLS_REJECT_UNAUTHORIZED.
 */

const SHOP_HOST = 'shop.test';
/** The same shop under `www.`, for a redirect from it to the apex (#347). */
export const WWW_SHOP_HOST = 'www.shop.test';
export const INTRANET_HOST = 'intranet.test';
const PUBLIC_IP = '127.0.0.2';
const PRIVATE_IP = '127.0.0.1';

const TEST_INTERNET: DestinationPolicy = {
  allowsAddress: (address) => address === PUBLIC_IP || isPublicAddress(address),
  allowsPort: () => true,
};

const NAMES: Record<string, string> = {
  [SHOP_HOST]: PUBLIC_IP,
  [WWW_SHOP_HOST]: PUBLIC_IP,
  [INTRANET_HOST]: PRIVATE_IP,
};

function resolve(hostname: string): Promise<ResolvedAddress[]> {
  const address = NAMES[hostname];
  if (!address) {
    return Promise.reject(
      Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
      }),
    );
  }
  return Promise.resolve([{ address, family: 4 }]);
}

/** A JPEG product shot in one colour. */
export function productShot(background: string): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 800, channels: 3, background } })
    .jpeg()
    .toBuffer();
}

export interface Page {
  status?: number;
  type: string;
  body: string | Buffer;
  headers?: Record<string, string>;
  /** Runs before the page is answered: what happens while the app is fetching it. */
  meanwhile?: () => Promise<void>;
}

/** One request as the site saw it. */
export interface SiteRequest {
  /** The path, query included. */
  path: string;
  host: string | undefined;
  /** The SNI the TLS client sent (false: none); null over plain HTTP. */
  servername: string | false | null;
}

export interface LinkSites {
  outboundFetch: NonNullable<AppOptions['outboundFetch']>;
  /** `http://shop.test:<port><path>` (or another host at the same port). */
  url(path: string, host?: string): string;
  /** `https://shop.test:<port><path>`: the same pages over TLS. */
  secureUrl(path: string, host?: string): string;
  /** Serve `page` at `path` from now on. */
  serve(path: string, page: Page): void;
  /** Every path requested, in order (query included). */
  hits: string[];
  /** Every request, in order, with its Host and SNI. */
  requests: SiteRequest[];
  close(): Promise<void>;
}

function listenOnPublicIp(server: Server): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, PUBLIC_IP, () =>
      done((server.address() as AddressInfo).port),
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
}

export async function startLinkSites(): Promise<LinkSites> {
  const pages = new Map<string, Page>();
  const hits: string[] = [];
  const requests: SiteRequest[] = [];
  const handler: RequestListener = (req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    requests.push({
      path,
      host: req.headers.host,
      servername:
        req.socket instanceof TLSSocket ? req.socket.servername : null,
    });
    const page = pages.get(path);
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const answer = () => {
      res.writeHead(page.status ?? 200, {
        'content-type': page.type,
        ...page.headers,
      });
      res.end(page.body);
    };
    if (!page.meanwhile) return answer();
    page.meanwhile().then(answer, (error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  };
  const certificate = selfSignedCertificate([SHOP_HOST, WWW_SHOP_HOST]);
  const server: Server = createServer(handler);
  const secureServer: Server = createHttpsServer(certificate, handler);
  const [port, securePort] = await Promise.all([
    listenOnPublicIp(server),
    listenOnPublicIp(secureServer),
  ]);
  return {
    outboundFetch: {
      resolve,
      destinations: TEST_INTERNET,
      tls: { ca: [certificate.cert] },
    },
    url: (path, host = SHOP_HOST) => `http://${host}:${port}${path}`,
    secureUrl: (path, host = SHOP_HOST) =>
      `https://${host}:${securePort}${path}`,
    serve: (path, page) => pages.set(path, page),
    hits,
    requests,
    close: async () => {
      await Promise.all([closeServer(server), closeServer(secureServer)]);
    },
  };
}

export function html(body: string): Page {
  return { type: 'text/html; charset=utf-8', body };
}

export function jpeg(body: Buffer): Page {
  return { type: 'image/jpeg', body };
}
