import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../project-root';

// 0000-0050 shipped before the rule (#603), so they are exempt by number.
const FIRST_CHECKED_MIGRATION = 51;

// Statements that take ACCESS EXCLUSIVE or SHARE ROW EXCLUSIVE (or SHARE, which
// blocks writers) on a table in use. CREATE INDEX CONCURRENTLY and a plain
// CREATE TABLE lock nothing that is in use.
const LOCKING_STATEMENT =
  /^\s*(ALTER\s+TABLE|CREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER|DROP\s+(TABLE|INDEX|TRIGGER)|TRUNCATE|CREATE\s+(UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY))\b/im;

const LOCK_TIMEOUT = /^SET\s+LOCAL\s+lock_timeout\b/i;

function withoutComments(chunk: string): string {
  return chunk.replace(/^\s*--.*$/gm, '').trim();
}

/** The failure message, or null when the migration is fine. */
function lockTimeoutProblem(file: string, sql: string): string | null {
  const statements = sql.split('--> statement-breakpoint').map(withoutComments);
  if (!statements.some((statement) => LOCKING_STATEMENT.test(statement)))
    return null;
  if (LOCK_TIMEOUT.test(statements[0] ?? '')) return null;
  return `drizzle/${file} takes table locks but does not start with SET LOCAL lock_timeout: add \`SET LOCAL lock_timeout = '5s';\` and a \`--> statement-breakpoint\` before its first statement (see 0051), so a boot behind a long reader fails and retries rather than queueing every request.`;
}

describe('migration lock_timeout (#603)', () => {
  const dir = join(PROJECT_ROOT, 'drizzle');
  const checked = readdirSync(dir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .filter((name) => Number(name.slice(0, 4)) >= FIRST_CHECKED_MIGRATION);

  it('finds the migrations it checks', () => {
    expect(checked.length).toBeGreaterThanOrEqual(2);
  });

  it.each(checked)('%s sets lock_timeout before locking a table', (file) => {
    expect(
      lockTimeoutProblem(file, readFileSync(join(dir, file), 'utf8')),
    ).toBeNull();
  });

  it('fails a locking migration without the line, naming file and fix', () => {
    const alter = '-- note\nALTER TABLE "garment" ADD COLUMN "x" integer;\n';
    expect(lockTimeoutProblem('9999_x.sql', alter)).toMatch(
      /9999_x\.sql.*SET LOCAL lock_timeout/,
    );
    expect(
      lockTimeoutProblem(
        '9999_x.sql',
        `SET LOCAL lock_timeout = '5s';\n--> statement-breakpoint\n${alter}`,
      ),
    ).toBeNull();
    expect(
      lockTimeoutProblem('9999_x.sql', 'CREATE TABLE "a" ("id" integer);'),
    ).toBeNull();
    expect(
      lockTimeoutProblem(
        '9999_x.sql',
        'CREATE INDEX CONCURRENTLY "i" ON "a" ("id");',
      ),
    ).toBeNull();
    expect(
      lockTimeoutProblem('9999_x.sql', 'CREATE INDEX "i" ON "a" ("id");'),
    ).not.toBeNull();
  });
});
