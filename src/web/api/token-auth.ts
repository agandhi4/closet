import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { TOKEN_PREFIX } from '../../credential-names';
import { HttpError } from '../errors';
import { t } from '../i18n';

/**
 * The API's credential (#190): a `device` token in `Authorization: Bearer`,
 * never the cookie (the root hook never resolves it on this surface) and
 * never the query string, checked by the bearer gate shared with /mcp
 * (src/web/auth/bearer-gate.ts). An `mcp` token is refused here as an
 * unknown one is, so a leaked agent token cannot drive the API (#189).
 */

/**
 * Every refusal of the credential is this one answer, whatever was wrong
 * (no header, two, a malformed one, an unknown, revoked or agent token), so
 * a probe learns nothing about which tokens exist. To a client it means one
 * thing: sign in again (POST /api/v1/auth/token).
 */
export function signInAgain(): HttpError {
  // quiet: the bearer gate logs its refusals itself (bearer-gate.ts).
  return new HttpError(401, t('api.SIGN_IN_AGAIN'), { quiet: true });
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
