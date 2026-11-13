import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../project-root';

// 0000-0050 shipped before the rule (#603), so they are exempt by number.
const FIRST_CHECKED_MIGRATION = 51;

// The first statement: comment lines before the first breakpoint are skipped.
// n > 0 in '<n>s' / '<n>ms' or a bare integer (ms); 0 means no limit.
const LOCK_TIMEOUT =
  /^SET\s+LOCAL\s+lock_timeout\s*(?:=|TO)\s*(?:'(\d+)\s*(?:ms|s)?'|(\d+))\s*;?\s*$/i;

function firstStatement(sql: string): string {
  const [first = ''] = sql.split('--> statement-breakpoint');
  return first.replace(/^\s*--.*$/gm, '').trim();
}

/** The failure message, or null when the migration is fine. */
function lockTimeoutProblem(file: string, sql: string): string | null {
  const match = LOCK_TIMEOUT.exec(firstStatement(sql));
  if (match && Number(match[1] ?? match[2]) > 0) return null;
  return `drizzle/${file} must start with a positive SET LOCAL lock_timeout: make its first statement \`SET LOCAL lock_timeout = '5s';\` followed by a \`--> statement-breakpoint\` (see 0051), so a boot behind a long reader fails and retries rather than queueing every request.`;
}

describe('migration lock_timeout (#603)', () => {
  const dir = join(PROJECT_ROOT, 'drizzle');
  const checked = readdirSync(dir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .filter((name) => Number(name.slice(0, 4)) >= FIRST_CHECKED_MIGRATION);

  it('finds the migrations it checks', () => {
    expect(checked.length).toBeGreaterThanOrEqual(2);
  });

  it.each(checked)('%s starts with a positive lock_timeout', (file) => {
    expect(
      lockTimeoutProblem(file, readFileSync(join(dir, file), 'utf8')),
    ).toBeNull();
  });

  const BREAK = '\n--> statement-breakpoint\n';
  const CREATE = 'CREATE TABLE "a" ("id" integer);';
  it.each([
    ['seconds', `SET LOCAL lock_timeout = '5s';${BREAK}${CREATE}`],
    ['milliseconds', `SET LOCAL lock_timeout = '500ms';${BREAK}${CREATE}`],
    ['a bare integer of ms', `SET LOCAL lock_timeout = 5000;${BREAK}${CREATE}`],
    [
      'comments before it',
      `-- why\n-- more\nSET LOCAL lock_timeout = '5s';${BREAK}${CREATE}`,
    ],
  ])('accepts %s', (_shape, sql) => {
    expect(lockTimeoutProblem('9999_x.sql', sql)).toBeNull();
  });

  it.each([
    ['missing', CREATE],
    ['zero', `SET LOCAL lock_timeout = '0';${BREAK}${CREATE}`],
    ['zero seconds', `SET LOCAL lock_timeout = '0s';${BREAK}${CREATE}`],
    ['a bare zero', `SET LOCAL lock_timeout = 0;${BREAK}${CREATE}`],
    ['not first', `${CREATE}${BREAK}SET LOCAL lock_timeout = '5s';`],
  ])('rejects %s, naming the file and the fix', (_shape, sql) => {
    expect(lockTimeoutProblem('9999_x.sql', sql)).toMatch(
      /9999_x\.sql.*SET LOCAL lock_timeout/,
    );
  });
});
