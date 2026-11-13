import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { TOKEN_PREFIX } from '../../credential-names';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { presentedBearer } from '../auth/bearer';
import { authenticateToken } from '../auth/personal-tokens';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { loggableUrl } from '../loggable-url';
import { rememberShareReadAhead, shareToReadAhead } from '../sharing/access';

/**
 * The API's credential (#190): a `device` token in `Authorization: Bearer`,
 * never the cookie (the root hook never resolves it on this surface) and
 * never the query string. An `mcp` token is refused here as an unknown one
 * is, so a leaked agent token cannot drive the API (#189).
 */

/**
 * Every refusal of the credential is this one answer, whatever was wrong
 * (no header, two, a malformed one, an unknown, revoked or agent token), so
 * a probe learns nothing about which tokens exist. To a client it means one
 * thing: sign in again (POST /api/v1/auth/token).
 */
export function signInAgain(): HttpError {
  return new HttpError(401, t('api.SIGN_IN_AGAIN'));
}

/**
 * The onRequest hook of every non-public API route (after refuseQueryToken):
 * before Fastify reads or parses the body, so an unauthenticated request is
 * a 401 whatever it sent, never a 400 for malformed JSON or a 413 for a body
 * past the limit, and a stranger's body is never read at all. One indexed
 * read (authenticateToken, with the `?ownerId=` share read ahead), plus the
 * last-use write once a minute. Logs the refusal's reason and the client
 * address, never the token.
 */
export function createDeviceTokenHook({
  db,
  logger,
}: {
  db: Db;
  logger: Logger;
}) {
  return async function requireDeviceToken(
    request: FastifyRequest,
  ): Promise<void> {
    if (request.routeOptions.config.public === true) return;
    const presented = presentedBearer(request);
    // A grantee's `?ownerId=` share rides in the token's read (#170), as a
    // page's rides in the session's: the access check costs no statement.
    const auth =
      'token' in presented
        ? await authenticateToken(db, presented.token, 'device', {
            shareOf: shareToReadAhead(request),
          })
        : undefined;
    if (!auth) {
      const reason =
        'token' in presented
          ? 'unknown, revoked or non-device token'
          : presented.refused;
      logger.warn(
        `API ${request.method} ${loggableUrl(request)} refused: ${reason} from ${request.ip}`,
      );
      throw signInAgain();
    }
    const { share, ...accessToken } = auth;
    request.accessToken = accessToken;
    if (share) rememberShareReadAhead(request, share);
  };
}

/** Query keys a client might put a token under, in any case. */
const TOKEN_KEYS = new Set(['access_token', 'token']);

/**
 * Whether a query string carries a token: a key named for one, or any
 * value, a repeated key's included, holding the prefix every personal
 * access token starts with.
 */
export function carriesQueryToken(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  return Object.entries(query).some(
    ([key, value]: [string, unknown]) =>
      TOKEN_KEYS.has(key.toLowerCase()) ||
      (Array.isArray(value) ? value : [value]).some(
        (item: unknown) =>
          typeof item === 'string' && item.includes(TOKEN_PREFIX),
      ),
  );
}

/**
 * The API's onRequest hook: a token in the query string is a 400 before
 * anything reads it (URLs reach logs, proxies and browser history), which
 * never echoes the value. loggableUrl filters it from the log lines.
 */
export function refuseQueryToken(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  done(
    carriesQueryToken(request.query)
      ? new HttpError(400, t('api.TOKEN_IN_QUERY'))
      : undefined,
  );
}
