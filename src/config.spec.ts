import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, trustedProxies, type Env } from './config';

// Everything without a default.
const REQUIRED: Env = {
  ACCESS_TOKEN_SECRET: 'x'.repeat(32),
  DATABASE_HOST: 'localhost',
  DATABASE_SCHEMA: 'closet_db',
  DATABASE_USER: 'closet',
  DATABASE_PASS: '',
};

const load = (env: Env, envFiles: string[] = []) =>
  loadConfig({ env: { ...REQUIRED, ...env }, envFiles });

const problemsOf = (env: Env): string[] => {
  try {
    loadConfig({ env, envFiles: [] });
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('loadConfig accepted the environment');
};

describe('loadConfig', () => {
  it('fills every default', () => {
    const config = load({});
    expect(config).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3000,
      LOG_LEVEL: 'info',
      TRUSTED_PROXIES: '127.0.0.1,::1',
      APP_NAME: 'Closet',
      APP_TIMEZONE: 'America/New_York',
      DISABLE_REGISTRATION: false,
      PWA_ENABLED: false,
      SITE_URL: 'http://localhost:3000',
      ICON_NAME: 'icon.png',
      WATERMARK_ENABLED: false,
      DATABASE_PORT: 5432,
      DATABASE_SSL: false,
      MAINTENANCE_ENABLED: true,
      MAX_HEIC_BYTES: 40 * 1024 * 1024,
    });
    expect(config.DATA_PATH).toBe(join(process.cwd(), 'data'));
    expect(config.PUBLIC_VAPID_KEY).toBeUndefined();
  });

  it('converts booleans and numbers spelled exactly', () => {
    const config = load({
      PORT: '8080',
      DISABLE_REGISTRATION: 'TRUE',
      DATABASE_SSL: 'false',
      MAX_HEIC_BYTES: '1024',
    });
    expect(config.PORT).toBe(8080);
    expect(config.DISABLE_REGISTRATION).toBe(true);
    expect(config.DATABASE_SSL).toBe(false);
    expect(config.MAX_HEIC_BYTES).toBe(1024);
  });

  it('ignores variables it does not declare', () => {
    expect(load({ HOME: '/root' })).not.toHaveProperty('HOME');
  });

  it('names every missing required variable, and accepts an empty database password', () => {
    expect(problemsOf({ DATABASE_PASS: '' })).toEqual([
      'ACCESS_TOKEN_SECRET: is required (at least 32 characters; generate one with: openssl rand -hex 32)',
      'DATABASE_HOST: is required',
      'DATABASE_SCHEMA: is required',
      'DATABASE_USER: is required',
    ]);
  });

  it.each([
    ['PORT', 'eighty', 'PORT: expected integer'],
    ['MAX_HEIC_BYTES', '1.5', 'MAX_HEIC_BYTES: expected integer'],
    [
      'MAX_HEIC_BYTES',
      '0',
      'MAX_HEIC_BYTES: expected integer to be greater or equal to 1',
    ],
    ['DISABLE_REGISTRATION', 'yes', 'DISABLE_REGISTRATION: expected boolean'],
    [
      'LOG_LEVEL',
      'verbose',
      'LOG_LEVEL: must be one of trace, debug, info, warn, error, fatal, silent',
    ],
    [
      'NODE_ENV',
      'staging',
      'NODE_ENV: must be one of development, production, test',
    ],
    ['APP_NAME', '', 'APP_NAME: expected string length greater or equal to 1'],
  ])('refuses %s=%j, naming it', (key, value, problem) => {
    expect(problemsOf({ ...REQUIRED, [key]: value })).toEqual([problem]);
  });

  it.each([
    ['the old default', 'ChangeMe!'],
    ['31 characters', 'x'.repeat(31)],
  ])(
    'refuses an ACCESS_TOKEN_SECRET of %s, saying how to make one',
    (_label, secret) => {
      expect(problemsOf({ ...REQUIRED, ACCESS_TOKEN_SECRET: secret })).toEqual([
        'ACCESS_TOKEN_SECRET: expected string length greater or equal to 32 (at least 32 characters; generate one with: openssl rand -hex 32)',
      ]);
    },
  );

  it('refuses an unknown time zone', () => {
    expect(problemsOf({ ...REQUIRED, APP_TIMEZONE: 'Mars/Olympus' })).toEqual([
      'APP_TIMEZONE: "Mars/Olympus" is not an IANA time zone',
    ]);
  });

  it('requires both VAPID keys when the PWA is on', () => {
    expect(problemsOf({ ...REQUIRED, PWA_ENABLED: 'true' })).toEqual([
      'PUBLIC_VAPID_KEY: is required when PWA_ENABLED is true',
      'PRIVATE_VAPID_KEY: is required when PWA_ENABLED is true',
    ]);
    expect(
      load({
        PWA_ENABLED: 'true',
        PUBLIC_VAPID_KEY: 'a',
        PRIVATE_VAPID_KEY: 'b',
      }).PWA_ENABLED,
    ).toBe(true);
  });

  it('never puts a value in the message', () => {
    try {
      loadConfig({
        env: {
          ACCESS_TOKEN_SECRET: 'too-short-secret',
          DATABASE_PASS: 'hunter2',
        },
        envFiles: [],
      });
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
      expect(String(error)).not.toContain('too-short-secret');
      expect(String(error)).toContain('ACCESS_TOKEN_SECRET');
      return;
    }
    throw new Error('loadConfig accepted the environment');
  });

  describe('env files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closet-config-'));
    const local = join(dir, '.env.local');
    const shared = join(dir, '.env');
    writeFileSync(local, 'APP_NAME=Local\nICON_NAME=local.png\n');
    writeFileSync(shared, 'APP_NAME=Shared\nSITE_URL=https://shared.test\n');

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('lets the environment win over the first file, and the first file over the second', () => {
      const config = load({ ICON_NAME: 'env.png' }, [local, shared]);
      expect(config.APP_NAME).toBe('Local');
      expect(config.ICON_NAME).toBe('env.png');
      expect(config.SITE_URL).toBe('https://shared.test');
    });

    it('skips a file that does not exist', () => {
      expect(load({}, [join(dir, 'missing')]).APP_NAME).toBe('Closet');
    });
  });
});

describe('trustedProxies', () => {
  it('splits and trims the list', () => {
    expect(
      trustedProxies({ TRUSTED_PROXIES: ' 10.0.0.1, 172.16.0.0/12 ,' }),
    ).toEqual(['10.0.0.1', '172.16.0.0/12']);
  });
});
