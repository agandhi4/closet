import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { SESSION_ENDED_HEADER } from '../page-cache';
import { findUserById } from './queries';
import {
  passwordFingerprint,
  SESSION_LIFETIME_SECONDS,
  type SessionTokens,
} from './tokens';

/** The signed-in user as every route and page sees it: never the hash. */
export interface SessionUser {
  id: number;
  email: string | null;
}

export interface AuthContext {
  user: SessionUser;
}

export const SESSION_COOKIE = 'access_token';

/** A session cookie's verdict: its session, or why it no longer opens one. */
type CookieVerdict = { auth: AuthContext } | { rejected: string };

/**
 * Resolves a request's session once: cookie -> JWT -> user row -> password
 * fingerprint. The root preValidation hook in app.ts calls it for every
 * non-static request and stores the result as `request.auth`;
 * requireSession, sessionUserId() and the page context only read that.
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

  const judge = async (token: string): Promise<CookieVerdict> => {
    const claims = tokens.verify(token);
    if (!claims) return { rejected: 'invalid signature, claims or expiry' };
    const user = await findUserById(db, claims.userId);
    if (!user) return { rejected: `unknown user ${claims.userId}` };
    if (passwordFingerprint(user.password) !== claims.pwf) {
      return { rejected: `password fingerprint mismatch for user ${user.id}` };
    }
    return { auth: { user: { id: user.id, email: user.email } } };
  };

  return async function resolveSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | undefined> {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return undefined;

    const verdict = await judge(token);
    if ('auth' in verdict) return verdict.auth;
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
 * Ends the session in this browser, and tells it to drop its HTTP cache so
 * the next person on the device cannot page back through this user's
 * wardrobe or its selfies (`private, immutable` for a year). Used by sign-out,
 * account deletion and the session resolver (a cookie that no longer opens a
 * session); every way a session ends on a device goes through here.
 *
 * "cache", not "storage": "storage" also unregisters the service worker and
 * empties its precache, so the installed app would lose its offline shell
 * (and its push subscription) until a page loaded online registered it
 * again. The worker's page cache, the one private thing in Cache Storage,
 * is dropped by the worker itself (views/assets/src-sw.ts: the sign-out
 * navigation, an auth POST answered with X-Session-Ended, and the
 * signed-out page a revoked session lands on).
 */
export function endSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  });
  reply.header('Clear-Site-Data', '"cache"');
  reply.header(SESSION_ENDED_HEADER, '1');
}
