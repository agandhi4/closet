import * as bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD_HASH_ROUNDS_PRODUCTION } from '../../config';
import {
  configurePasswordHashing,
  hashPassword,
  passwordHashing,
  verifyPassword,
} from './passwords';

describe('password hashing', () => {
  afterEach(() => configurePasswordHashing(PASSWORD_HASH_ROUNDS_PRODUCTION));

  // bcrypt's time is set by the cost in the hash: an unknown email must pay
  // what a real account's comparison does (#136), at every configured cost.
  it('the unknown-account hash has the configured cost, production included', async () => {
    expect(bcrypt.getRounds(passwordHashing().unknownAccountHash)).toBe(
      PASSWORD_HASH_ROUNDS_PRODUCTION,
    );
    configurePasswordHashing(4);
    expect(bcrypt.getRounds(passwordHashing().unknownAccountHash)).toBe(4);
    expect(bcrypt.getRounds(await hashPassword('Password123!'))).toBe(4);
  });

  it('verifyPassword without an account is false whatever the password', async () => {
    configurePasswordHashing(4);
    expect(await verifyPassword('Password123!', undefined)).toBe(false);
    expect(await verifyPassword('', undefined)).toBe(false);
  });
});
