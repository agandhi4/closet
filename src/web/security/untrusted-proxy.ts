import type { FastifyRequest } from 'fastify';
import type { Logger } from '../../logger';

/**
 * Notices a proxy that is missing from TRUSTED_PROXIES (#671). Fastify takes
 * `request.ip` from X-Forwarded-For only when the peer is trusted; a peer
 * outside the list that still sends the header is a proxy whose clients all
 * read as one address, so SIGN_IN_LIMIT and BEARER_REFUSAL_LIMIT become
 * household-wide: five typos lock everyone out. With nothing else amiss that
 * state is invisible until it bites, so it is logged once per boot and
 * reported by /health/ready's `trusted_proxies` check (optional: the app
 * serves).
 *
 * `request.ips` is the peer first, then each trusted hop's claim, so a
 * length of one with the header present means the peer was not believed.
 * Anything that reaches the app directly can send the header too: the
 * verdict only ever flags a configuration to look at, never refuses.
 */
export class UntrustedProxyWatch {
  #peer: string | undefined;

  constructor(private readonly logger: Logger) {}

  /** The peer that sent X-Forwarded-For without being trusted, once seen. */
  get peer(): string | undefined {
    return this.#peer;
  }

  /** A root onRequest hook: one comparison per request, one log line per boot. */
  observe(request: FastifyRequest): void {
    if (this.#peer !== undefined) return;
    // A blank value names no client, so a trusted proxy sending one is no finding.
    if (![request.headers['x-forwarded-for']].flat().join('').trim()) return;
    if ((request.ips?.length ?? 1) > 1) return;
    const peer = request.socket.remoteAddress ?? 'unknown';
    this.#peer = peer;
    this.logger.warn(
      `${peer} sent X-Forwarded-For but is not in TRUSTED_PROXIES: every client behind it shares one address, so the sign-in and credential rate limits are household-wide (docs/operations.md#trusted-proxies)`,
    );
  }
}
