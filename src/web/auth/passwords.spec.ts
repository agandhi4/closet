import * as bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  UNKNOWN_ACCOUNT_HASH,
  verifyPassword,
} from './passwords';

describe('verifyPassword without an account', () => {
  // bcrypt's time is set by the cost in the hash: an unknown email must pay
  // what a real account's comparison does (#136).
  it('compares against a hash of the same cost as a real password', async () => {
    const real = await hashPassword('Password123!');
    expect(bcrypt.getRounds(UNKNOWN_ACCOUNT_HASH)).toBe(bcrypt.getRounds(real));
  });

  it('is false whatever the password', async () => {
    expect(await verifyPassword('Password123!', undefined)).toBe(false);
    expect(await verifyPassword('', undefined)).toBe(false);
  });
});
