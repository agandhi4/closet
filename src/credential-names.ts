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
