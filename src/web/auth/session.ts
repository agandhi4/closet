import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { loggableUrl } from '../loggable-url';
import { SESSION_ENDED_HEADER } from '../page-cache';
import { type AccountRow, findSessionAccount } from './queries';
import { SESSION_LIFETIME_SECONDS, type SessionTokens } from './tokens';

/** The signed-in user as every route and page sees it: never the hash. */
export interface SessionUser {
  id: number;
  email: string | null;
}

export interface AuthContext {
  user: SessionUser;
}

export const SESSION_COOKIE = 'access_token';

/**
 * A session cookie's verdict: its session (and, on a `checksPassword` route,
 * the account row with its hash), or why it no longer opens one.
 */
type CookieVerdict =
  | { auth: AuthContext; account?: AccountRow }
  | { rejected: string };

/**
 * The account rows the session lookup read with their hash, by request: kept
 * off `request.auth`, which the views and logs see, so a hash has no path
 * into a page or a log line. Filled only for `checksPassword` routes.
 */
const accountsWithHash = new WeakMap<FastifyRequest, AccountRow>();

/**
 * The signed-in account with its password hash, on a route that says
 * `config: { checksPassword: true }`: the session lookup read it, so the
 * route's password check costs no second read of the row. Read from the
 * same statement that checked the session's fingerprint, so the hash it
 * verifies against is the one that session was judged by. Calling it
 * anywhere else is a programming error.
 */
export function sessionAccount(request: FastifyRequest): AccountRow {
  const account = accountsWithHash.get(request);
  if (!account) {
    throw new Error(
      `sessionAccount() on ${request.method} ${loggableUrl(request)}, which has no session or no config.checksPassword`,
    );
  }
  return account;
}

/**
 * Resolves a request's session once: cookie -> JWT -> user row -> password
 * fingerprint. The root preValidation hook in app.ts calls it for every
 * non-static request and stores the result as `request.auth`;
 * requireSession, sessionUserId() and the page context only read that.
 *
 * One statement, every request, never cached (src/web/security/CLAUDE.md):
 * the row is read fresh because comparing its fingerprint is the
 * revocation. It reads the id, the email (the app bar, the order mail's
 * owner) and the hash's 8-character suffix, not the hash (#171); a
 * `checksPassword` route's lookup reads the hash too, for sessionAccount().
 *
 * A cookie that no longer opens a session is ended here, on whatever route
 * it arrives (endSession: the cookie cleared, Clear-Site-Data sent). That
 * covers every way a session ends away from this device: a password changed
 * on another one or by `user:set-password` (the fingerprint), the account
 * deleted elsewhere (no row), a rotated ACCESS_TOKEN_SECRET or a garbled
 * token (the signature), and expiry. This is the one place such a device is
 * noticed, so it is where it drops the account's HTTP cache (selfies,
 * pages); the session gate's redirect or 401 then carries both headers, and
 * the login page it lands on drops the browser's push subscription
 * (PushSignedOut, src/web/push/settings.tsx). A request without the cookie
 * gets neither header: nothing was signed in there.
 */
export function createSessionResolver(deps: {
  db: Db;
  tokens: SessionTokens;
  logger: Logger;
}) {
  const { db, tokens, logger } = deps;

  const judge = async (
    token: string,
    withHash: boolean,
  ): Promise<CookieVerdict> => {
    const claims = tokens.verify(token);
    if (!claims) return { rejected: 'invalid signature, claims or expiry' };
    const row = await findSessionAccount(db, claims.userId, withHash);
    if (!row) return { rejected: `unknown user ${claims.userId}` };
    if (row.fingerprint !== claims.pwf) {
      return { rejected: `password fingerprint mismatch for user ${row.id}` };
    }
    const user = { id: row.id, email: row.email };
    return {
      auth: { user },
      account:
        row.password === undefined
          ? undefined
          : { ...user, password: row.password },
    };
  };

  return async function resolveSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | undefined> {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return undefined;

    const verdict = await judge(
      token,
      request.routeOptions.config.checksPassword === true,
    );
    if ('auth' in verdict) {
      if (verdict.account) accountsWithHash.set(request, verdict.account);
      return verdict.auth;
    }
    endSession(reply);
    logger.info(
      `Rejected access token (${verdict.rejected}): cookie cleared, Clear-Site-Data sent`,
    );
    return undefined;
  };
}

/**
 * The session cookie. httpOnly (no script reads it), SameSite=Lax (not sent
 * on cross-site POSTs; the same-origin hook is the other half of the CSRF
 * defence), and deliberately not Secure: `http://closet.box` is plain HTTP
 * by design, and a Secure cookie would never be stored there (CLAUDE.md,
 * Conventions). Max-Age is in seconds (@fastify/cookie passes it through as
 * the attribute) and matches the token's own expiry.
 */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    maxAge: SESSION_LIFETIME_SECONDS,
    httpOnly: true,
    sameSite: 'lax',
  });
}

/**
 * Signs `userId` in on this browser with a freshly issued `token` (sign-in,
 * registration) and answers whose live session it replaced, if another
 * account's. The login form stays open to a signed-in user, so signing in as
 * B over A's session ends A's on this device as surely as a sign-out: the new
 * cookie replaces A's, and Clear-Site-Data: "cache" drops what the HTTP cache
 * holds for A (its photos and selfies, immutable for a year), as endSession
 * does (#229). The service worker drops its own session caches on the
 * sign-in's redirect (views/assets/src-sw.ts). The same account signing in
 * again keeps its cache; a dead cookie was already ended by the resolver,
 * header included, so there is no live session to replace.
 */
export function startSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: number,
  token: string,
): number | undefined {
  setSessionCookie(reply, token);
  const previous = request.auth?.user.id;
  if (previous === undefined || previous === userId) return undefined;
  clearHttpCache(reply);
  return previous;
}

/**
 * "cache", not "storage": "storage" also unregisters the service worker and
 * empties its precache, so the installed app would lose its offline shell
 * (and its push subscription) until a page loaded online registered it
 * again. The worker's session caches, the private things in Cache Storage,
 * are dropped by the worker itself (views/assets/src-sw.ts: the sign-in and
 * sign-out navigations, an auth POST answered with X-Session-Ended, and the
 * signed-out page a revoked session lands on). Cookies are untouched, so a
 * cookie set on the same answer (startSession) survives it. Ignored outside
 * a secure context (`http://closet.box`) and before Safari 17.
 */
function clearHttpCache(reply: FastifyReply): void {
  reply.header('Clear-Site-Data', '"cache"');
}

/**
 * Ends the session in this browser, and tells it to drop its HTTP cache so
 * the next person on the device cannot page back through this user's
 * wardrobe or its selfies (`private, immutable` for a year). Used by sign-out,
 * account deletion and the session resolver (a cookie that no longer opens a
 * session); every way a session ends on a device goes through here, but for
 * another account signing in over it (startSession).
 */
export function endSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  });
  clearHttpCache(reply);
  reply.header(SESSION_ENDED_HEADER, '1');
}
