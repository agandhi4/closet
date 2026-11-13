import type { FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { enforceLimit, type RateLimitChecker } from '../security/rate-limit';
import { verifyPassword } from './passwords';
import { type AccountRow, findUserByEmail, normalizeEmail } from './queries';

/**
 * Who a sign-in's email and password open: the login page's and the API's
 * device sign-in's one check (src/web/auth/routes.tsx, api-routes.ts), so
 * both doors normalise the address alike and cost alike. Exactly one bcrypt
 * comparison whatever the outcome: a wrong password, and an unknown email
 * against the unknown-account hash of the same cost (verifyPassword), so
 * the answer's timing does not tell which addresses have accounts.
 * `userId` on a refusal is for the log line alone, never the answer.
 */
export type SignInCheck =
  | { ok: true; account: AccountRow }
  | { ok: false; userId?: number };

export async function checkSignIn(
  db: Db,
  email: string,
  password: string,
): Promise<SignInCheck> {
  const account = await findUserByEmail(db, normalizeEmail(email));
  if (!(await verifyPassword(password, account?.password)) || !account) {
    return { ok: false, userId: account?.id };
  }
  return { ok: true, account };
}

/** The log line's name for whose sign-in failed. */
export function failedSignInFor(check: { userId?: number }): string {
  return check.userId === undefined
    ? 'an unknown email'
    : `user ${check.userId}`;
}

/**
 * What the two sign-in doors are registered with: their one SIGN_IN_LIMIT
 * checker, built once in webPlugin (a checker per door would be a budget
 * each).
 */
export interface SignInLimit {
  signInLimit: RateLimitChecker;
}

/**
 * The sign-in doors' onRequest hook: counts the attempt against the shared
 * per-address budget before the body is read.
 */
export function signInGate(checker: RateLimitChecker, logger: Logger) {
  return (request: FastifyRequest) =>
    enforceLimit(checker, request, { logger, who: request.ip });
}
