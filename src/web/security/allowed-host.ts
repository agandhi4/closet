import type { onRequestHookHandler } from 'fastify';
import { hostAllowlist } from '../../allowed-hosts';
import type { Logger } from '../../logger';

// Distinct refused hosts named in a warn line per boot: enough to show a
// missing ALLOWED_HOSTS entry, too few for a prober's random names to flood.
const LOGGED_HOSTS_MAX = 20;
// A Host header can be 16 KB; a DNS name is at most 253 characters.
const LOGGED_HOST_CHARS = 260;

/**
 * DNS rebinding (#702): a page at attacker.example whose name now resolves
 * to this server sends Host and Origin both attacker.example, which the
 * same-origin check (it compares Origin with the request's own Host)
 * accepts. This root onRequest hook, added before that check, answers any
 * request whose Host (`request.host`: X-Forwarded-Host only from a trusted
 * proxy) is not SITE_URL's, an ALLOWED_HOSTS entry or loopback with a
 * bodiless 421 Misdirected Request (RFC 9110 15.5.20: this server does not
 * answer for that authority), before any route, body or session, static
 * paths and the bearer surfaces included.
 *
 * Not an HttpError: the error handler always writes a body (a problem with
 * a `validation` code on /api, a page elsewhere), and a misdirected request
 * is owed none. The access line records each refusal; a warn line names
 * each of the first LOGGED_HOSTS_MAX distinct hosts, so a name missing
 * from ALLOWED_HOSTS shows once rather than on every request.
 */
export function createAllowedHostHook(options: {
  allowedHosts: readonly string[];
  logger: Logger;
}): onRequestHookHandler {
  const allows = hostAllowlist(options.allowedHosts);
  const logged = new Set<string>();
  const { logger } = options;
  const accepted = options.allowedHosts.join(', ') || 'none';

  function note(host: string): void {
    const shown = host.slice(0, LOGGED_HOST_CHARS);
    if (logged.has(shown) || logged.size > LOGGED_HOSTS_MAX) return;
    logged.add(shown);
    if (logged.size > LOGGED_HOSTS_MAX) {
      logger.warn(
        `Refused more than ${LOGGED_HOSTS_MAX} hosts since boot; no further host is named`,
      );
      return;
    }
    logger.warn(
      `Refused a request for host ${JSON.stringify(shown)} with 421 (accepts ${accepted} and loopback; ALLOWED_HOSTS adds a name)`,
    );
  }

  return function requireAllowedHost(request, reply, done) {
    if (allows(request.host)) {
      done();
      return;
    }
    note(request.host);
    // Answered here: done() is not called, so no later hook or route runs.
    reply.code(421).send();
  };
}
