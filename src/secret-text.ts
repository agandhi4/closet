import { SESSION_COOKIE, TOKEN_PREFIX } from './credential-names';

// Credential shapes inside free text. Used by src/metrics/error-tracker.ts (every string of an
// event) and src/logger.ts (errorFields' message and stack): one list, so a shape added here
// leaves neither Bugsink nor app.log/Loki. Closet leaked session JWTs to Loki once
// (docs/audits/2026-09-25-closet-stack-and-backups.md): the session token is a JWT, so every
// JWT goes, whatever carried it.

export const FILTERED = '[Filtered]';

const SECRET_PATTERNS: [RegExp, string][] = [
  [/eyJ[\w-]*\.[\w-]+\.[\w-]*/g, FILTERED],
  [
    new RegExp(`\\b${SESSION_COOKIE}=[^;\\s"']*`, 'g'),
    `${SESSION_COOKIE}=${FILTERED}`,
  ],
  [new RegExp(`\\b${TOKEN_PREFIX}[\\w-]+`, 'g'), `${TOKEN_PREFIX}${FILTERED}`],
  [/\bBearer\s+[^\s"']+/gi, `Bearer ${FILTERED}`],
  // Fastmail API tokens (the order mail's, #25): `fmu1-` and hex groups.
  [/\bfm[a-z]\d-[\w-]+/gi, FILTERED],
  // Drizzle's failed-query message ends with the query's parameters: what a user sent (an
  // email, a hash, a note), never needed to group or debug an error. In a stack the frames
  // follow, so the cut stops at the first frame or cause and keeps them; a parameter that
  // itself holds "\n    at " ends the cut early.
  [/\nparams: [\s\S]*?(?=\n\s+at |\ncaused by: |$)/g, `\nparams: ${FILTERED}`],
];

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (scrubbed, [pattern, replacement]) =>
      scrubbed.replace(pattern, replacement),
    text,
  );
}
