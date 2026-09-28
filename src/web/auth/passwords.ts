import * as bcrypt from 'bcryptjs';
import type { Db } from '../../db/client';
import { markSecretChecked } from '../../metrics/request-timing';
import type { StringKey } from '../i18n';
import { type PasswordChange, updatePasswordHash } from './queries';

const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Compared against when the account does not exist, so an unknown email
 * costs the same bcrypt work as a wrong password and response times do not
 * tell which addresses have accounts. A BCRYPT_ROUNDS hash of a random
 * string that was thrown away; its value is irrelevant, since no account
 * matches it (verifyPassword answers false whatever the comparison says).
 * A constant, not a hash made on first use: that made the first unknown
 * email after each boot cost a hash and a comparison, twice a real
 * account's time (#136).
 */
export const UNKNOWN_ACCOUNT_HASH =
  '$2b$12$2XMqcJVfAECVq8kMYvFPKOWE4G13BXHCFM.4YGO5pHDP8rUtNwe8S';

/** Whether `password` is the one behind `hash`; false, at the same cost, when there is no account. */
export async function verifyPassword(
  password: string,
  hash: string | undefined,
): Promise<boolean> {
  markSecretChecked();
  if (hash === undefined) {
    await bcrypt.compare(password, UNKNOWN_ACCOUNT_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}

/**
 * The rules every new password meets wherever it is set: registration, the
 * change-password form and `npm run user:set-password`. Each problem is the
 * t() key of the message shown under the field.
 */
export function passwordProblems(password: string): StringKey[] {
  const problems: StringKey[] = [];
  if (password.length < 8) problems.push('validation.MIN_PASSWORD_LENGTH');
  if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
    problems.push('validation.PASSWORD_MUST_CONTAIN');
  }
  return problems;
}

/**
 * Replaces a user's password: the change-password route and `npm run
 * user:set-password` both come through here. The new hash changes the
 * fingerprint every session token carries (tokens.ts), so every session
 * issued before is rejected from the next request on, and every personal
 * access token and push subscription is revoked with it
 * (updatePasswordHash). `keepEndpoint`: the push subscription of the device
 * making the change, which stays signed in (the route); the CLI has none,
 * so every device goes. Returns the updated row, for a caller that issues
 * this device a fresh token, and what was revoked, for its log line.
 */
export async function setPassword(
  db: Db,
  userId: number,
  password: string,
  keepEndpoint?: string,
): Promise<PasswordChange> {
  return updatePasswordHash(
    db,
    userId,
    await hashPassword(password),
    keepEndpoint,
  );
}
