import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { connectionOptions, dbConfig } from './client';

const dir = mkdtempSync(join(tmpdir(), 'closet-db-ca-'));
afterAll(() => rmSync(dir, { recursive: true }));

// node-postgres's `ssl` as DATABASE_SSL sets it (#694): the env through
// loadConfig and dbConfig to what the pool and the listener connect with.
const sslFor = (env: Record<string, string>) =>
  connectionOptions(
    dbConfig(
      loadConfig({
        env: {
          ACCESS_TOKEN_SECRET: 'x'.repeat(32),
          DATABASE_HOST: 'db.example',
          DATABASE_NAME: 'closet',
          DATABASE_USER: 'closet',
          DATABASE_PASS: '',
          ...env,
        },
        envFiles: [],
      }),
    ),
  ).ssl;

describe('the database TLS option', () => {
  it('verifies the server under verify, against DATABASE_SSL_CA when given', () => {
    expect(sslFor({ DATABASE_SSL: 'verify' })).toEqual({
      rejectUnauthorized: true,
    });
    const ca = join(dir, 'ca.pem');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\n');
    expect(sslFor({ DATABASE_SSL: 'verify', DATABASE_SSL_CA: ca })).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\n',
    });
  });

  it('accepts any certificate under no-verify (and the deprecated true)', () => {
    for (const DATABASE_SSL of ['no-verify', 'true']) {
      expect(sslFor({ DATABASE_SSL })).toEqual({ rejectUnauthorized: false });
    }
  });

  // false, not undefined: node-postgres reads PGSSLMODE when `ssl` is unset.
  it('is plaintext under off, the default', () => {
    expect(sslFor({})).toBe(false);
    expect(sslFor({ DATABASE_SSL: 'off' })).toBe(false);
  });
});
