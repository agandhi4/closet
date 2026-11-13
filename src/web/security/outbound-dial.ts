import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

/**
 * The one way the outbound fetcher (outbound-fetch.ts) opens a connection,
 * and the only module that may (scripts/ci/guards.conf: @outbound-tls,
 * @outbound-tcp). It connects to the address `pin()` checked, an IP
 * literal, so nothing between the check and the connect resolves a name
 * (DNS rebinding). Over TLS the certificate is verified against the URL's
 * name, which is also the SNI; a URL naming an IP literal is verified
 * against that IP and sends no SNI (Node refuses an IP as servername).
 */

/**
 * Certificates trusted instead of the system's: the specs' TLS fixture
 * only (test/support/tls-certificate.ts). Never from Config: production
 * verifies against Node's roots.
 */
export interface TrustedCertificates {
  ca: string[];
}

export interface DialTarget {
  /** The URL's host: a name, or an IP literal without brackets. */
  host: string;
  /** The checked address, an IP literal: the only thing connected to. */
  address: string;
  port: number;
  secure: boolean;
}

/**
 * HTTP/1.1 alone until #496b brings the h2 transport: a server offered h2
 * may pick it and then expect frames, which the HTTP/1.1 client cannot
 * send, and redialing would be a second connection. Offering only
 * HTTP/1.1 gets what a client offering no ALPN (the fetcher before #496a)
 * got.
 */
const ALPN_PROTOCOLS = ['http/1.1'];

/** A connected socket (TLS handshake done) to the target's checked address. */
export function dial(
  { host, address, port, secure }: DialTarget,
  signal: AbortSignal,
  trusted: TrustedCertificates | undefined,
): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = secure
      ? connectTls({
          host: address,
          port,
          ...(isIP(host) ? {} : { servername: host }),
          ALPNProtocols: ALPN_PROTOCOLS,
          rejectUnauthorized: true,
          ca: trusted?.ca,
        })
      : connectTcp({ host: address, port });
    // tls.connect takes no signal: a stalled connect or handshake ends
    // here, at the fetch's timeout. Removed once connected; the request
    // then holds the signal.
    const onAbort = () => socket.destroy(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    // Attached before the socket can emit and never removed: after the
    // hand-off the request listens too, but an error the moment it detaches
    // (a reset as the response ends) must not reach the process unheard.
    socket.on('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      signal.removeEventListener('abort', onAbort);
      resolve(socket);
    });
  });
}
