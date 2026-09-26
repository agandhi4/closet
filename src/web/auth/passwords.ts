import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import type { StringKey } from '../i18n';
import { type AccountRow, updatePasswordHash } from './queries';

const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Compared against when the account does not exist, so an unknown email
 * costs the same bcrypt work as a wrong password and response times do not
 * tell which addresses have accounts. A hash of a random string, made on
 * first use (a 12-round hash is too slow for every boot and unit test).
 */
let unknownAccountHash: Promise<string> | undefined;

/** Whether `password` is the one behind `hash`; false, at the same cost, when there is no account. */
export async function verifyPassword(
  password: string,
  hash: string | undefined,
): Promise<boolean> {
  if (hash === undefined) {
    unknownAccountHash ??= hashPassword(randomUUID());
    await bcrypt.compare(password, await unknownAccountHash);
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
 * issued before is rejected from the next request on. Returns the updated
 * row, for a caller that issues this device a fresh token.
 */
export async function setPassword(
  db: Db,
  userId: number,
  password: string,
): Promise<AccountRow> {
  return updatePasswordHash(db, userId, await hashPassword(password));
}
