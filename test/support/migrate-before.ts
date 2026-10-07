import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'pg';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate';

interface Journal {
  entries: { tag: string }[];
}

/**
 * Applies drizzle/ up to, not including, `drizzle/NNNN_<name>.sql`: the
 * schema a build before that migration left. A migration spec seeds rows
 * in that shape, then applies the rest (runMigrations, or createTestApp's
 * boot) or stops before a later migration with another call. Drizzle's
 * migrator applies whatever is newer than the last applied entry, so
 * consecutive calls move a database forward step by step.
 *
 * A spec of a migration on the wardrobe plan tables reads its result
 * before `drop-plans` (0045, #337), which drops them.
 */
export async function migrateBefore(
  client: Client,
  name: string,
): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  // A tag is NNNN_<name>; the name must name exactly one migration.
  const named = (tag: string) => tag.slice(tag.indexOf('_') + 1) === name;
  const index = journal.entries.findIndex((e) => named(e.tag));
  if (index < 1 || journal.entries.filter((e) => named(e.tag)).length > 1) {
    throw new Error(`No single migration after the first is named ${name}`);
  }
  journal.entries = journal.entries.slice(0, index);
  const dir = await mkdtemp(join(tmpdir(), 'closet-drizzle-'));
  try {
    await mkdir(join(dir, 'meta'));
    await writeFile(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify(journal),
    );
    for (const { tag } of journal.entries) {
      await copyFile(
        join(MIGRATIONS_FOLDER, `${tag}.sql`),
        join(dir, `${tag}.sql`),
      );
    }
    await migrate(drizzle(client), { migrationsFolder: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Which of the wardrobe plan tables 0045_drop-plans drops still exist. */
export async function planTablesLeft(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `select table_name as name from information_schema.tables
     where table_schema = current_schema() and table_name = any($1)
     order by table_name`,
    [
      [
        'wardrobe_plan',
        'plan_item',
        'plan_item_candidate',
        'plan_item_rejection',
        'plan_look',
        'plan_look_slot',
      ],
    ],
  );
  return rows.map((row) => row.name);
}
