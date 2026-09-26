import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import type { WebLogger } from '../logger';
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

/**
 * Resolves a request's session once: cookie -> JWT -> user row -> password
 * fingerprint. The root preHandler in app.ts calls it for every non-static
 * request and stores the result as `request.auth`; SessionGuard, @UserId(),
 * the web layer's requireSession and the page context only read that.
 */
export function createSessionResolver(deps: {
  db: Db;
  tokens: SessionTokens;
  logger: WebLogger;
}) {
  const { db, tokens, logger } = deps;
  return async function resolveSession(
    request: FastifyRequest,
  ): Promise<AuthContext | undefined> {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return undefined;

    const claims = tokens.verify(token);
    if (!claims) {
      logger.log('Rejected access token: invalid signature, claims or expiry');
      return undefined;
    }
    const user = await findUserById(db, claims.userId);
    if (!user) {
      logger.log(`Access token for unknown user ${claims.userId}`);
      return undefined;
    }
    if (passwordFingerprint(user.password) !== claims.pwf) {
      logger.log(`Password fingerprint mismatch for user ${user.id}`);
      return undefined;
    }
    return { user: { id: user.id, email: user.email } };
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
 * wardrobe. The service worker's page cache is cleared by the worker itself
 * (views/assets/src-sw.ts, on the logout navigation): Clear-Site-Data
 * "cache" does not reach Cache Storage everywhere.
 */
export function endSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  });
  reply.header('Clear-Site-Data', '"cache"');
}
