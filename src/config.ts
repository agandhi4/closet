import { KindGuard, type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value, ValueErrorType } from '@sinclair/typebox/value';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { isValidTimeZone } from './web/calendar/calendar-date';

/**
 * The application's configuration: every environment variable it reads,
 * declared once here with its default and its rule, and validated at boot.
 * `loadConfig()` is the only reader of process.env in src/; everything else
 * receives the typed object (createApp, the CLIs) or a slice of it. A new
 * variable goes here with a default and gets a row in the README's
 * configuration table.
 */

const NonEmpty = (options: { default?: string } = {}) =>
  Type.String({ minLength: 1, ...options });

// Loopback only: right for `npm run start:prod` on a laptop, wrong behind a
// containerised reverse proxy (production sets the Docker bridge range).
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.1,::1';

export const ACCESS_TOKEN_SECRET_MIN = 32;

export const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union(
    [
      Type.Literal('development'),
      Type.Literal('production'),
      Type.Literal('test'),
    ],
    { default: 'production' },
  ),
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  // pino level for both the console and app.log.
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('trace'),
      Type.Literal('debug'),
      Type.Literal('info'),
      Type.Literal('warn'),
      Type.Literal('error'),
      Type.Literal('fatal'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  // Comma-separated IPs/CIDRs whose X-Forwarded-* headers are trusted
  // (Fastify trustProxy): the client IP the rate limits count and the origin
  // the same-origin check compares. Behind a reverse proxy it must include
  // the proxy's address (CLAUDE.md, Trusted proxies).
  TRUSTED_PROXIES: NonEmpty({ default: DEFAULT_TRUSTED_PROXIES }),
  APP_NAME: NonEmpty({ default: 'Closet' }),
  // The household's IANA time zone: it decides what "today" is on the
  // calendar and which week opens by default. One zone, because one
  // household shares the calendar; an unknown name fails the boot.
  APP_TIMEZONE: NonEmpty({ default: 'America/New_York' }),
  DISABLE_REGISTRATION: Type.Boolean({ default: false }),
  PWA_ENABLED: Type.Boolean({ default: false }),
  // Signs every session token (HS256). No default on purpose: a known
  // secret lets anyone mint a session for any user id. 32 characters is the
  // floor (`openssl rand -hex 32` gives 64).
  ACCESS_TOKEN_SECRET: Type.String({ minLength: ACCESS_TOKEN_SECRET_MIN }),
  // No defaults on purpose: a PWA deploy that forgot its VAPID keys must fail
  // at boot rather than push with a keypair anyone can read from git.
  // Required when PWA_ENABLED (checked below).
  PUBLIC_VAPID_KEY: Type.Optional(NonEmpty()),
  PRIVATE_VAPID_KEY: Type.Optional(NonEmpty()),
  // Also the VAPID subject of Web Push (src/web/push/sender.ts), which
  // web-push requires to be https: when PWA_ENABLED is true.
  SITE_URL: NonEmpty({ default: 'http://localhost:3000' }),
  // File under public/assets/ used for apple-touch-icon, Open Graph previews
  // and the share-link watermark.
  ICON_NAME: NonEmpty({ default: 'icon.png' }),
  // Composite the app icon onto share-link Open Graph images.
  WATERMARK_ENABLED: Type.Boolean({ default: false }),
  DATA_PATH: NonEmpty({ default: join(process.cwd(), 'data') }),
  // Postgres is the only database. No defaults on purpose: a missing value
  // must fail the boot, not reach localhost.
  DATABASE_HOST: NonEmpty(),
  DATABASE_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 5432 }),
  DATABASE_SCHEMA: NonEmpty(),
  DATABASE_USER: NonEmpty(),
  // Empty is valid: pgvault-dev and the test databases use trust auth.
  DATABASE_PASS: Type.String(),
  DATABASE_SSL: Type.Boolean({ default: false }),
  // Nightly storage reconciliation at 03:00 APP_TIMEZONE, scheduled by the
  // server (main.ts); `npm run maintenance:reconcile` runs it once
  // regardless.
  MAINTENANCE_ENABLED: Type.Boolean({ default: true }),
  // HEIC uploads are decoded in memory before sharp sees them; a part larger
  // than this is a 413.
  MAX_HEIC_BYTES: Type.Integer({ minimum: 1, default: 40 * 1024 * 1024 }),
});

export type Config = Static<typeof ConfigSchema>;

/** Variables as the process sees them (process.env's shape). */
export type Env = Record<string, string | undefined>;

/** The boot stops here, naming every offending variable (never its value). */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

// Earlier files win over later ones, and the environment over both.
// `.env` is committed (public defaults); `.env.local` is gitignored, for
// development only. The Docker image bakes `.env` and never sees
// `.env.local`, so production configuration is real environment variables.
const ENV_FILES = ['.env.local', '.env'];

export interface LoadConfigOptions {
  /** Defaults to process.env. */
  env?: Env;
  /** Files, relative to the working directory; defaults to .env.local, .env. */
  envFiles?: string[];
}

export function loadConfig({
  env = process.env,
  envFiles = ENV_FILES,
}: LoadConfigOptions = {}): Config {
  const merged: Env = {};
  for (const file of [...envFiles].reverse()) {
    Object.assign(merged, readEnvFile(file));
  }
  Object.assign(merged, env);

  const values: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(ConfigSchema.properties)) {
    const raw = merged[key];
    if (raw !== undefined) values[key] = coerce(schema, raw);
  }
  const config: unknown = Value.Default(ConfigSchema, values);

  const problems = describeErrors(config);
  if (problems.length === 0) {
    problems.push(...crossFieldProblems(config as Config));
  }
  if (problems.length) throw new ConfigError(problems);
  return config as Config;
}

function readEnvFile(file: string): Env {
  const path = resolve(process.cwd(), file);
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/**
 * Environment values are strings; booleans and numbers are converted only
 * when they spell one exactly, so anything else stays a string and fails the
 * schema with the variable's name. (TypeBox's Value.Convert would truncate
 * "1.5" to an integer and accept "1" as true.)
 */
function coerce(schema: TSchema, raw: string): unknown {
  if (KindGuard.IsBoolean(schema)) {
    const lower = raw.trim().toLowerCase();
    return lower === 'true' ? true : lower === 'false' ? false : raw;
  }
  if (KindGuard.IsNumber(schema) || KindGuard.IsInteger(schema)) {
    const number = Number(raw);
    return raw.trim() !== '' && Number.isFinite(number) ? number : raw;
  }
  return raw;
}

// What to do about a refused value, where the rule alone does not say.
const HINTS: Partial<Record<keyof Config, string>> = {
  ACCESS_TOKEN_SECRET: `at least ${ACCESS_TOKEN_SECRET_MIN} characters; generate one with: openssl rand -hex 32`,
};

function describeErrors(config: unknown): string[] {
  const byKey = new Map<string, string>();
  for (const error of Value.Errors(ConfigSchema, config)) {
    const key = error.path.slice(1);
    if (byKey.has(key)) continue;
    const hint = HINTS[key as keyof Config];
    byKey.set(
      key,
      `${key}: ${describe(error.type, error.schema, error.message)}${hint ? ` (${hint})` : ''}`,
    );
  }
  return [...byKey.values()];
}

function describe(
  type: ValueErrorType,
  schema: TSchema,
  message: string,
): string {
  if (type === ValueErrorType.ObjectRequiredProperty) return 'is required';
  if (KindGuard.IsUnion(schema)) {
    const allowed = schema.anyOf.map((option) => String(option.const));
    return `must be one of ${allowed.join(', ')}`;
  }
  return message.charAt(0).toLowerCase() + message.slice(1);
}

function crossFieldProblems(config: Config): string[] {
  const problems: string[] = [];
  if (!isValidTimeZone(config.APP_TIMEZONE)) {
    problems.push(
      `APP_TIMEZONE: "${config.APP_TIMEZONE}" is not an IANA time zone`,
    );
  }
  if (config.PWA_ENABLED) {
    for (const key of ['PUBLIC_VAPID_KEY', 'PRIVATE_VAPID_KEY'] as const) {
      if (!config[key]) {
        problems.push(`${key}: is required when PWA_ENABLED is true`);
      }
    }
  }
  return problems;
}

/** TRUSTED_PROXIES as Fastify's trustProxy list. */
export function trustedProxies(config: Pick<Config, 'TRUSTED_PROXIES'>) {
  return config.TRUSTED_PROXIES.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
