import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Socket,
} from 'node:net';
import {
  createServer as createTlsServer,
  type Server as TlsServer,
} from 'node:tls';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress } from '../../src/web/security/public-address';
import {
  BYTE_LIMITS,
  createOutboundFetcher,
  type DestinationPolicy,
  OutboundFetchError,
  type OutboundFetchRefusal,
  PUBLIC_DESTINATIONS,
  type ResolvedAddress,
} from '../../src/web/security/outbound-fetch';
import { captureLogs } from '../support/log-capture';
import {
  selfSignedCertificate,
  type TestCertificate,
} from '../support/tls-certificate';
import { startLinkSites } from './link-sites';

/**
 * The SSRF guard against real sockets. Everything listens on loopback, which
 * the guard refuses, so the specs that need a reachable "internet" widen the
 * policy to one loopback alias, 127.0.0.2 (Linux routes all of 127/8 to lo),
 * and keep 127.0.0.1 as the private address that must never be reached.
 * Names resolve through a scripted resolver; no spec touches real DNS.
 */

const PUBLIC_IP = '127.0.0.2';
const PRIVATE_IP = '127.0.0.1';

/** The public internet, plus 127.0.0.2 standing in for it; any port. */
const TEST_INTERNET: DestinationPolicy = {
  allowsAddress: (address) => address === PUBLIC_IP || isPublicAddress(address),
  allowsPort: () => true,
};
/** The production address rules on any port (the servers' ports are random). */
const PRODUCTION_ADDRESSES_ANY_PORT: DestinationPolicy = {
  allowsAddress: PUBLIC_DESTINATIONS.allowsAddress,
  allowsPort: () => true,
};

interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
}

interface TestServer {
  port: number;
  hits: Hit[];
  close(): Promise<void>;
}

async function listen(
  host: string,
  handler: RequestListener,
  port = 0,
): Promise<TestServer> {
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  return started(server, host, port, hits);
}

interface TlsTestServer extends TestServer {
  server: Server;
  /** Resets (TCP RST) the latest connection under its TLS. */
  reset(): void;
}

/** An HTTPS server on 127.0.0.2 presenting `certificate`. */
async function listenTls(
  certificate: TestCertificate,
  handler: RequestListener,
): Promise<TlsTestServer> {
  const hits: Hit[] = [];
  let latest: Socket | undefined;
  const server: Server = createHttpsServer(certificate, (req, res) => {
    hits.push({ path: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  server.on('connection', (socket: Socket) => {
    latest = socket;
  });
  return {
    ...(await started(server, PUBLIC_IP, 0, hits)),
    server,
    reset: () => latest?.resetAndDestroy(),
  };
}

async function started(
  server: Server,
  host: string,
  port: number,
  hits: Hit[],
): Promise<TestServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A resolver answering from a table; `calls` records every lookup. */
function scriptedResolver(
  table: Record<string, string | ((call: number) => string)>,
) {
  const calls: string[] = [];
  const resolve = (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    const entry = table[hostname];
    if (entry === undefined) {
      return Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
        }),
      );
    }
    const address =
      typeof entry === 'function'
        ? entry(calls.filter((h) => h === hostname).length)
        : entry;
    return Promise.resolve([
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
  };
  return { resolve, calls };
}

const html =
  (body: string): RequestListener =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };

async function refusal(promise: Promise<unknown>): Promise<OutboundFetchError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OutboundFetchError);
  return error as OutboundFetchError;
}

async function expectRefused(
  promise: Promise<unknown>,
  reason: OutboundFetchRefusal,
): Promise<OutboundFetchError> {
  const error = await refusal(promise);
  expect(error.reason).toBe(reason);
  return error;
}

describe('outbound fetch (SSRF guard)', () => {
  const servers: TestServer[] = [];
  const serve = async (host: string, handler: RequestListener, port = 0) => {
    const server = await listen(host, handler, port);
    servers.push(server);
    return server;
  };

  // The private address every refusal spec checks was never reached.
  let privateServer: TestServer;

  beforeAll(async () => {
    privateServer = await listen(
      PRIVATE_IP,
      html('<title>Router admin</title>'),
    );
  });

  afterAll(() => privateServer.close());

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(privateServer.hits).toEqual([]);
  });

  describe('a page on the public internet', () => {
    it('is fetched from the address that was checked, with the name as Host', async () => {
      const shop = await serve(PUBLIC_IP, html('<title>Tee</title>'));
      const dns = scriptedResolver({ 'shop.test': PUBLIC_IP });
      const { logger } = captureLogs();
      const fetcher = createOutboundFetcher({
        logger,
        resolve: dns.resolve,
        destinations: TEST_INTERNET,
      });

      const page = await fetcher.fetch(
        `http://shop.test:${shop.port}/products/tee?variant=1`,
        { accept: ['html', 'image'] },
      );

      expect(page.kind).toBe('html');
      expect(page.mediaType).toBe('text/html');
      expect(page.charset).toBe('utf-8');
      expect(page.body.toString('utf8')).toBe('<title>Tee</title>');
      expect(page.url.href).toBe(
        `http://shop.test:${shop.port}/products/tee?variant=1`,
      );
      expect(shop.hits).toHaveLength(1);
      expect(shop.hits[0].path).toBe('/products/tee?variant=1');
      expect(shop.hits[0].headers.host).toBe(`shop.test:${shop.port}`);
      expect(dns.calls).toEqual(['shop.test']);
    });

    it('sends no cookie or credentials, and names itself', async () => {
      const shop = await serve(PUBLIC_IP, (req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, {
            location: '/end',
            'set-cookie': 'session=abc; Path=/',
          });
          res.end();
          return;
        }
        html('ok')(req, res);
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });

      await fetcher.fetch(`http://shop.test:${shop.port}/start`, {
        accept: ['html'],
      });

      expect(shop.hits.map((hit) => hit.path)).toEqual(['/start', '/end']);
      for (const { headers } of shop.hits) {
        expect(headers.cookie).toBeUndefined();
        expect(headers.authorization).toBeUndefined();
        expect(headers['user-agent']).toMatch(/Closet/);
      }
    });

    it('decodes a gzipped body', async () => {
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-encoding': 'gzip',
        });
        res.end(gzipSync('<title>Zipped</title>'));
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });

      const page = await fetcher.fetch(`http://shop.test:${shop.port}/`, {
        accept: ['html'],
      });

      expect(page.body.toString()).toBe('<title>Zipped</title>');
    });

    it('reads an image as an image', async () => {
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      const cdn = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'cdn.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });

      const image = await fetcher.fetch(`http://cdn.test:${cdn.port}/a.png`, {
        accept: ['image'],
      });

      expect(image.kind).toBe('image');
      expect(image.mediaType).toBe('image/png');
      expect(image.body.equals(png)).toBe(true);
    });

    it('logs the host only, never the path or query', async () => {
      const shop = await serve(PUBLIC_IP, html('ok'));
      const { logger, logs } = captureLogs();
      const fetcher = createOutboundFetcher({
        logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });

      await fetcher.fetch(
        `http://shop.test:${shop.port}/secret-path?token=hunter2`,
        { accept: ['html'] },
      );
      await refusal(
        fetcher.fetch(`http://shop.test:${shop.port}/other-secret?token=x`, {
          accept: ['image'],
        }),
      );

      expect(logs.messages('info')).toEqual([
        expect.stringContaining('shop.test'),
      ]);
      expect(logs.messages('warn')).toEqual([
        expect.stringContaining('shop.test'),
      ]);
      expect(logs.text()).not.toMatch(/secret|token|hunter2/);
    });
  });

  describe('refuses before connecting', () => {
    it.each([
      ['a loopback name', 'internal.test', PRIVATE_IP],
      ['an RFC 1918 name', 'nas.test', '192.168.1.20'], // topology example
      ['a Tailscale name', 'tailnet.test', '100.100.1.1'], // topology example
      ['a cloud metadata name', 'metadata.test', '169.254.169.254'],
      ['an IPv6 loopback name', 'v6.test', '::1'],
      ['an IPv4-mapped loopback name', 'mapped.test', '::ffff:127.0.0.1'],
    ])('%s', async (_label, hostname, address) => {
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ [hostname]: address }).resolve,
        destinations: PRODUCTION_ADDRESSES_ANY_PORT,
      });

      await expectRefused(
        fetcher.fetch(`http://${hostname}:${privateServer.port}/`, {
          accept: ['html'],
        }),
        'blocked-address',
      );
    });

    it('a private address literal', async () => {
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        destinations: PRODUCTION_ADDRESSES_ANY_PORT,
      });

      for (const host of [PRIVATE_IP, '[::1]', '[::ffff:7f00:1]', '0x7f.1']) {
        await expectRefused(
          fetcher.fetch(`http://${host}:${privateServer.port}/`, {
            accept: ['html'],
          }),
          'blocked-address',
        );
      }
    });

    it('a name with any private address among its answers', async () => {
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: () =>
          Promise.resolve([
            { address: PUBLIC_IP, family: 4 },
            { address: PRIVATE_IP, family: 4 },
          ]),
        destinations: TEST_INTERNET,
      });

      await expectRefused(
        fetcher.fetch(`http://split.test:${privateServer.port}/`, {
          accept: ['html'],
        }),
        'blocked-address',
      );
    });

    it.each([
      ['file:///etc/passwd', 'unsupported-scheme'],
      ['ftp://shop.test/', 'unsupported-scheme'],
      ['javascript:alert(1)', 'unsupported-scheme'],
      ['not a url', 'invalid-url'],
      ['http://user:pass@shop.test/', 'credentials-in-url'],
      ['http://shop.test:8080/', 'port-not-allowed'],
      ['https://shop.test:80/', 'port-not-allowed'],
    ] as const)('%s (%s)', async (url, reason) => {
      const dns = scriptedResolver({ 'shop.test': PUBLIC_IP });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: dns.resolve,
      });

      await expectRefused(fetcher.fetch(url, { accept: ['html'] }), reason);
      expect(dns.calls).toEqual([]);
    });

    it('a name that does not resolve', async () => {
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({}).resolve,
      });

      await expectRefused(
        fetcher.fetch('http://nowhere.test/', { accept: ['html'] }),
        'unresolvable',
      );
    });
  });

  describe('redirects', () => {
    it('refuses a redirect to a private address', async () => {
      const shop = await serve(PUBLIC_IP, (req, res) => {
        const to =
          req.url === '/literal'
            ? `http://${PRIVATE_IP}:${privateServer.port}/`
            : `http://internal.test:${privateServer.port}/`;
        res.writeHead(302, { location: to });
        res.end();
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({
          'shop.test': PUBLIC_IP,
          'internal.test': PRIVATE_IP,
        }).resolve,
        destinations: TEST_INTERNET,
      });

      for (const path of ['/literal', '/name']) {
        await expectRefused(
          fetcher.fetch(`http://shop.test:${shop.port}${path}`, {
            accept: ['html'],
          }),
          'blocked-address',
        );
      }
      expect(shop.hits).toHaveLength(2);
    });

    it('keeps a fetch that names its hosts on them, redirects included', async () => {
      const other = await serve(PUBLIC_IP, html('<title>Elsewhere</title>'));
      const api = await serve(PUBLIC_IP, (req, res) => {
        if (req.url === '/away') {
          res.writeHead(302, { location: `http://other.test:${other.port}/` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({
          'api.test': PUBLIC_IP,
          'other.test': PUBLIC_IP,
        }).resolve,
        destinations: TEST_INTERNET,
      });
      const request = { accept: ['json'], hosts: ['api.test'] } as const;

      const fetched = await fetcher.fetch(
        `http://api.test:${api.port}/v1`,
        request,
      );
      expect(fetched.kind).toBe('json');
      expect(JSON.parse(fetched.body.toString('utf8'))).toEqual({ ok: true });
      await expectRefused(
        fetcher.fetch(`http://api.test:${api.port}/away`, request),
        'host-not-allowed',
      );
      await expectRefused(
        fetcher.fetch(`http://other.test:${other.port}/`, request),
        'host-not-allowed',
      );
      expect(other.hits).toEqual([]);
    });

    it("sends a fixed API's credential and JSON body to its hosts, and follows no redirect with them (#25)", async () => {
      const bodies: string[] = [];
      const api = await serve(PUBLIC_IP, (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          bodies.push(Buffer.concat(chunks).toString('utf8'));
          if (req.url === '/moved') {
            // Same host, even: a credential is never carried past a redirect.
            res.writeHead(307, { location: `/jmap` });
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'api.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });
      const request = {
        accept: ['json'],
        hosts: ['api.test'],
        authorization: 'Bearer fmu1-secret',
        json: { using: ['core'] },
      } as const;

      await fetcher.fetch(`http://api.test:${api.port}/jmap`, request);
      const [hit] = api.hits;
      expect(hit.headers.authorization).toBe('Bearer fmu1-secret');
      expect(hit.headers['content-type']).toBe('application/json');
      expect(bodies[0]).toBe('{"using":["core"]}');

      const moved = await expectRefused(
        fetcher.fetch(`http://api.test:${api.port}/moved`, request),
        'http-status',
      );
      expect(moved.status).toBe(307);
      expect(api.hits.map((h) => h.path)).toEqual(['/jmap', '/moved']);

      // A credential for a URL anyone could name is a programming error,
      // thrown before anything is resolved.
      await expect(
        fetcher.fetch(`http://api.test:${api.port}/jmap`, {
          accept: ['json'],
          authorization: 'Bearer fmu1-secret',
        }),
      ).rejects.toThrow('must name its hosts');
      expect(api.hits).toHaveLength(2);
    });

    it('refuses a redirect to another scheme', async () => {
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(301, { location: 'file:///etc/passwd' });
        res.end();
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });

      await expectRefused(
        fetcher.fetch(`http://shop.test:${shop.port}/`, { accept: ['html'] }),
        'unsupported-scheme',
      );
    });

    it('follows three and refuses the fourth', async () => {
      const shop = await serve(PUBLIC_IP, (req, res) => {
        const step = Number(req.url!.slice(1));
        if (step === 99) return html('done')(req, res);
        res.writeHead(307, { location: `/${step + 1}` });
        res.end();
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });

      const followed = await fetcher.fetch(`http://shop.test:${shop.port}/96`, {
        accept: ['html'],
      });
      expect(followed.redirects).toBe(3);
      expect(followed.url.pathname).toBe('/99');

      shop.hits.length = 0;
      await expectRefused(
        fetcher.fetch(`http://shop.test:${shop.port}/1`, { accept: ['html'] }),
        'too-many-redirects',
      );
      expect(shop.hits.map((hit) => hit.path)).toEqual([
        '/1',
        '/2',
        '/3',
        '/4',
      ]);
    });
  });

  describe('DNS rebinding', () => {
    it('connects to the address it checked, never to a second answer', async () => {
      // The name answers public first and private on every later lookup. A
      // fetcher that checked one answer and let the socket resolve again
      // would land on the private server, which listens on the same port.
      const shop = await serve(PUBLIC_IP, html('<title>Public</title>'));
      const internal = await serve(PRIVATE_IP, html('internal'), shop.port);
      const dns = scriptedResolver({
        'rebind.test': (call) => (call === 1 ? PUBLIC_IP : PRIVATE_IP),
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: dns.resolve,
        destinations: TEST_INTERNET,
      });

      const page = await fetcher.fetch(`http://rebind.test:${shop.port}/`, {
        accept: ['html'],
      });

      expect(page.body.toString()).toBe('<title>Public</title>');
      expect(dns.calls).toEqual(['rebind.test']);
      expect(shop.hits).toHaveLength(1);
      expect(internal.hits).toEqual([]);
    });

    it('checks the name again on a redirect back to itself', async () => {
      const shop = await serve(PUBLIC_IP, (req, res) => {
        res.writeHead(302, { location: '/again' });
        res.end();
      });
      const internal = await serve(PRIVATE_IP, html('internal'), shop.port);
      const dns = scriptedResolver({
        'rebind.test': (call) => (call === 1 ? PUBLIC_IP : PRIVATE_IP),
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: dns.resolve,
        destinations: TEST_INTERNET,
      });

      await expectRefused(
        fetcher.fetch(`http://rebind.test:${shop.port}/`, { accept: ['html'] }),
        'blocked-address',
      );
      expect(internal.hits).toEqual([]);
    });

    it('keeps the name for TLS (SNI) while connecting to the checked address', async () => {
      // No certificate: the handshake is refused once the server has read
      // the name the client asked for, which is all this needs to see.
      const names: string[] = [];
      const tlsServer: TlsServer = createTlsServer({
        SNICallback: (name, callback) => {
          names.push(name);
          callback(new Error('no certificate in this test'));
        },
      });
      await new Promise<void>((resolve) =>
        tlsServer.listen(0, PUBLIC_IP, resolve),
      );
      const { port } = tlsServer.address() as AddressInfo;
      const dns = scriptedResolver({ 'secure.test': PUBLIC_IP });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: dns.resolve,
        destinations: TEST_INTERNET,
      });

      try {
        await expectRefused(
          fetcher.fetch(`https://secure.test:${port}/`, { accept: ['html'] }),
          'network',
        );
      } finally {
        await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
      }
      expect(names).toEqual(['secure.test']);
      expect(dns.calls).toEqual(['secure.test']);
    });
  });

  describe('limits', () => {
    const fetcherFor = (timeoutMs?: number) =>
      createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
        timeoutMs,
      });

    it('cuts a page at 2 MB while it streams, reading no further (#347)', async () => {
      // An endless body: a fetcher that read it whole before checking would
      // never return.
      let written = 0;
      let closed = false;
      const chunk = Buffer.alloc(64 * 1024, 'a');
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.on('close', () => {
          closed = true;
        });
        const pump = () => {
          while (!res.destroyed && res.write(chunk)) written += chunk.length;
          if (!res.destroyed) res.once('drain', pump);
        };
        pump();
      });

      const page = await fetcherFor().fetch(`http://shop.test:${shop.port}/`, {
        accept: ['html'],
      });
      expect(page).toMatchObject({ kind: 'html', truncated: true });
      expect(page.body.length).toBe(BYTE_LIMITS.html);
      await expect.poll(() => closed).toBe(true);
      expect(BYTE_LIMITS.html).toBe(2 * 1024 * 1024);
      expect(written).toBeLessThan(BYTE_LIMITS.html + 4 * 1024 * 1024);
    });

    it('refuses a declared length past the cap without reading the body', async () => {
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': String(BYTE_LIMITS.image + 1),
        });
        res.write(Buffer.alloc(1024));
      });

      await expectRefused(
        fetcherFor().fetch(`http://shop.test:${shop.port}/`, {
          accept: ['image'],
        }),
        'too-large',
      );
    });

    it('counts the decoded bytes of a compressed body', async () => {
      const bomb = gzipSync(Buffer.alloc(BYTE_LIMITS.image + 1024));
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-encoding': 'gzip',
        });
        res.end(bomb);
      });

      expect(bomb.length).toBeLessThan(BYTE_LIMITS.image);
      await expectRefused(
        fetcherFor().fetch(`http://shop.test:${shop.port}/`, {
          accept: ['image'],
        }),
        'too-large',
      );
    });

    it.each([
      ['a page where an image was expected', 'text/html', ['image']],
      ['an image where a page was expected', 'image/png', ['html']],
      ['an SVG', 'image/svg+xml', ['image']],
      ['JSON', 'application/json', ['html', 'image']],
      ['a binary stream', 'application/octet-stream', ['image']],
      ['no content type', undefined, ['html', 'image']],
    ] as const)('refuses %s', async (_label, contentType, accept) => {
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(200, contentType ? { 'content-type': contentType } : {});
        res.end('body');
      });

      await expectRefused(
        fetcherFor().fetch(`http://shop.test:${shop.port}/`, { accept }),
        'unexpected-content-type',
      );
    });

    it('refuses an error status', async () => {
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('gone');
      });

      const error = await expectRefused(
        fetcherFor().fetch(`http://shop.test:${shop.port}/`, {
          accept: ['html'],
        }),
        'http-status',
      );
      expect(error.status).toBe(404);
    });

    // #347's shops, as they answered: Cloudflare's challenge (campmor),
    // Shopify's storefront limit (darntough, blauerboardshop), AWS WAF's
    // challenge in a 2xx (sunandski).
    it.each([
      ['a 403', 403, {}],
      ['a 429', 429, { 'retry-after': '60' }],
      ["AWS WAF's challenge, a 202", 202, { 'x-amzn-waf-action': 'challenge' }],
      ["Cloudflare's challenge", 503, { 'cf-mitigated': 'challenge' }],
    ] as const)(
      'tells a site that blocks automated fetches: %s',
      async (_label, status, headers) => {
        const shop = await serve(PUBLIC_IP, (_req, res) => {
          res.writeHead(status, { 'content-type': 'text/html', ...headers });
          res.end('<title>Just a moment...</title>');
        });
        const { logger, logs } = captureLogs();
        const fetcher = createOutboundFetcher({
          logger,
          resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
          destinations: TEST_INTERNET,
        });

        const error = await expectRefused(
          fetcher.fetch(`http://shop.test:${shop.port}/`, {
            accept: ['html', 'image'],
          }),
          'blocked-by-site',
        );
        expect(error.status).toBe(status);
        expect(logs.messages('warn')).toEqual([
          expect.stringMatching(
            new RegExp(
              `^Outbound fetch refused \\(blocked-by-site\\): shop\\.test answered ${status} after \\d+ ms$`,
            ),
          ),
        ]);
      },
    );

    it('gives up on a server that never answers', async () => {
      const shop = await serve(PUBLIC_IP, () => {
        // Never responds.
      });

      const started = Date.now();
      await expectRefused(
        fetcherFor(300).fetch(`http://shop.test:${shop.port}/`, {
          accept: ['html'],
        }),
        'timeout',
      );
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('bounds the whole fetch, not each read: a trickling body times out', async () => {
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        const drip = setInterval(() => {
          if (res.destroyed) clearInterval(drip);
          else res.write('.');
        }, 20);
        res.on('close', () => clearInterval(drip));
      });

      const started = Date.now();
      await expectRefused(
        fetcherFor(300).fetch(`http://shop.test:${shop.port}/`, {
          accept: ['html'],
        }),
        'timeout',
      );
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('allows only the default ports in production', () => {
      expect(PUBLIC_DESTINATIONS.allowsPort(80, 'http:')).toBe(true);
      expect(PUBLIC_DESTINATIONS.allowsPort(443, 'https:')).toBe(true);
      expect(PUBLIC_DESTINATIONS.allowsPort(8080, 'http:')).toBe(false);
      expect(PUBLIC_DESTINATIONS.allowsPort(443, 'http:')).toBe(false);
    });
  });

  // #496a: the fetcher dials the checked address itself (outbound-dial.ts)
  // and speaks HTTP/1.1 on that socket, over TLS when the URL says https.
  describe('connections', () => {
    const serveTls = async (
      certificate: TestCertificate,
      handler: RequestListener,
    ) => {
      const server = await listenTls(certificate, handler);
      servers.push(server);
      return server;
    };

    it('verifies TLS against the name, which is SNI and Host, resolving it once per hop', async () => {
      const sites = await startLinkSites();
      try {
        sites.serve('/start', {
          status: 302,
          type: 'text/html',
          body: '',
          headers: { location: sites.secureUrl('/tee') },
        });
        sites.serve('/tee', {
          type: 'text/html; charset=utf-8',
          body: '<title>Tee</title>',
        });
        // A second lookup of either name would answer the private address.
        const rebinding = (call: number) =>
          call === 1 ? PUBLIC_IP : PRIVATE_IP;
        const dns = scriptedResolver({
          'shop.test': rebinding,
          'www.shop.test': rebinding,
        });
        const fetcher = createOutboundFetcher({
          logger: captureLogs().logger,
          ...sites.outboundFetch,
          resolve: dns.resolve,
        });

        const start = sites.secureUrl('/start', 'www.shop.test');
        const page = await fetcher.fetch(start, { accept: ['html'] });

        expect(page.body.toString()).toBe('<title>Tee</title>');
        expect(page.redirects).toBe(1);
        const port = new URL(start).port;
        expect(sites.requests).toEqual([
          {
            path: '/start',
            host: `www.shop.test:${port}`,
            servername: 'www.shop.test',
          },
          { path: '/tee', host: `shop.test:${port}`, servername: 'shop.test' },
        ]);
        expect(dns.calls).toEqual(['www.shop.test', 'shop.test']);
      } finally {
        await sites.close();
      }
    });

    it.each([
      [
        'an untrusted self-signed certificate',
        selfSignedCertificate(['shop.test']),
        false,
        'DEPTH_ZERO_SELF_SIGNED_CERT',
      ],
      [
        'a trusted certificate for another name',
        selfSignedCertificate(['elsewhere.test']),
        true,
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ],
    ] as const)(
      'refuses %s before sending anything, logging the code alone',
      async (_label, certificate, trusted, code) => {
        const shop = await serveTls(certificate, html('<title>Tee</title>'));
        const { logger, logs } = captureLogs();
        const fetcher = createOutboundFetcher({
          logger,
          resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
          destinations: TEST_INTERNET,
          // Untrusted: the production roots, as no `tls` option gives.
          ...(trusted && { tls: { ca: [certificate.cert] } }),
        });

        await expectRefused(
          fetcher.fetch(`https://shop.test:${shop.port}/`, {
            accept: ['html'],
          }),
          'network',
        );

        expect(shop.hits).toEqual([]);
        expect(logs.messages('warn')).toEqual([
          expect.stringMatching(
            new RegExp(
              `^Outbound fetch refused \\(network\\): shop\\.test after \\d+ ms \\(${code}\\)$`,
            ),
          ),
        ]);
      },
    );

    it('refuses a connection reset after the handshake or mid-response, and stays up', async () => {
      const certificate = selfSignedCertificate(['shop.test']);
      const afterHandshake = await serveTls(certificate, html('never'));
      afterHandshake.server.on('secureConnection', () =>
        afterHandshake.reset(),
      );
      const midResponse = await serveTls(certificate, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<title>Te', () => midResponse.reset());
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
        tls: { ca: [certificate.cert] },
      });

      for (const { port } of [afterHandshake, midResponse]) {
        await expectRefused(
          fetcher.fetch(`https://shop.test:${port}/`, { accept: ['html'] }),
          'network',
        );
      }
      expect(midResponse.hits).toHaveLength(1);
    });

    it('gives up on a stalled TLS handshake and closes its socket', async () => {
      // Reads the ClientHello and never says a word back. Reading is what
      // lets it see the client's FIN: an unread socket never ends.
      let closed = false;
      const silent = createTcpServer((socket) => {
        socket.resume();
        socket.on('close', () => {
          closed = true;
        });
      });
      await new Promise<void>((resolve) =>
        silent.listen(0, PUBLIC_IP, resolve),
      );
      const { port } = silent.address() as AddressInfo;
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
        timeoutMs: 300,
      });

      try {
        const started = Date.now();
        await expectRefused(
          fetcher.fetch(`https://shop.test:${port}/`, { accept: ['html'] }),
          'timeout',
        );
        expect(Date.now() - started).toBeLessThan(2000);
        await expect.poll(() => closed).toBe(true);
      } finally {
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    });

    it('skips a 1xx informational answer for the response after it', async () => {
      const shop = await serve(PUBLIC_IP, (_req, res) => {
        res.writeEarlyHints({ link: '</style.css>; rel=preload' }, () => {
          html('<title>Tee</title>')(_req, res);
        });
      });
      const fetcher = createOutboundFetcher({
        logger: captureLogs().logger,
        resolve: scriptedResolver({ 'shop.test': PUBLIC_IP }).resolve,
        destinations: TEST_INTERNET,
      });

      const page = await fetcher.fetch(`http://shop.test:${shop.port}/`, {
        accept: ['html'],
      });

      expect(page.body.toString()).toBe('<title>Tee</title>');
    });
  });
});
