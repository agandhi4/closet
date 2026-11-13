// The names closet's credentials travel under, below both the code that issues them and the
// code that redacts them, so the error tracker never imports a web module (scripts/ci/layers.conf).

/**
 * The session cookie's name. Used by src/web/auth/session.ts (sets, reads and clears it) and
 * src/metrics/error-tracker.ts (redacts it from events).
 */
export const SESSION_COOKIE = 'access_token';

/**
 * Every personal access token starts with this. Used by src/web/auth/personal-tokens.ts (mints
 * and recognises tokens) and src/secret-text.ts (redacts them from events and log lines).
 */
export const TOKEN_PREFIX = 'closet_';

/**
 * What a personal access token is for (#189): `mcp`, minted on Agent Access for /mcp, or
 * `device`, a native client's sign-in for /api. Each surface authenticates only its own kind
 * (authenticateToken). Used by src/db/schema.ts (the column's check) and src/web/auth.
 */
export const TOKEN_KINDS = ['mcp', 'device'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
