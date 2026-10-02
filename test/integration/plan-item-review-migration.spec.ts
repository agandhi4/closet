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
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { silentLogger } from './logger';

/**
 * The plan item review migrations (#278: drizzle/0033_plan-item-review.sql
 * adds plan_item.review and backfills it, 0034 drops `proposed`) on a
 * database the previous build migrated: an agent's unaccepted item
 * (proposed true) becomes 'proposed', every other one 'accepted', and the
 * new constraints hold.
 */

let database: ScratchDatabase;
let client: Client;
let folder: string;

function configOf(env: Record<string, string>): DbConfig {
  return {
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT),
    database: env.DATABASE_SCHEMA,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASS,
    ssl: false,
  };
}

interface Journal {
  entries: { tag: string }[];
}

/** A copy of drizzle/ that stops before the review migration. */
async function migrationsBeforeReview(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'closet-drizzle-'));
  await mkdir(join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const index = journal.entries.findIndex((e) =>
    e.tag.endsWith('_plan-item-review'),
  );
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const { tag } of journal.entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${tag}.sql`),
      join(dir, `${tag}.sql`),
    );
  }
  return dir;
}

async function insert(text: string, values: unknown[] = []): Promise<number> {
  return (await client.query<{ id: number }>(`${text} returning id`, values))
    .rows[0].id;
}

beforeEach(async () => {
  database = await createScratchDatabase('closet_it');
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
  folder = await migrationsBeforeReview();
  await migrate(drizzle(client), { migrationsFolder: folder });
});

afterEach(async () => {
  await client?.end();
  await database?.drop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('plan item review (the plan-item-review migrations)', () => {
  it('maps proposed true to proposed and false to accepted, and drops the boolean', async () => {
    const owner = await insert(
      `insert into "user" (email, password) values ('owner@example.com', 'x')`,
    );
    const plan = await insert(
      `insert into wardrobe_plan (owner_id, name, active) values ($1, 'Spring', true)`,
      [owner],
    );
    const item = (category: string, proposed: boolean) =>
      insert(
        `insert into plan_item (plan_id, category, proposed, note, created_at)
         values ($1, $2, $3, 'why', '2026-09-01T10:00:00Z')`,
        [plan, category, proposed],
      );
    const accepted = await item('tops', false);
    const proposed = await item('bottoms', true);

    await runMigrations(configOf(database.env), silentLogger);

    const { rows } = await client.query<{
      id: number;
      review: string;
      owner_note: string | null;
      note: string;
    }>(`select id, review, owner_note, note from plan_item order by id`);
    expect(
      rows.map(({ id, review, owner_note, note }) => ({
        id,
        review,
        owner_note,
        note,
      })),
    ).toEqual([
      { id: accepted, review: 'accepted', owner_note: null, note: 'why' },
      { id: proposed, review: 'proposed', owner_note: null, note: 'why' },
    ]);
    const { rows: columns } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'plan_item'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('proposed');
    // changed_at (0033) gave way to the agent's own stamp (#278 part 2).
    expect(names).not.toContain('changed_at');
    expect(names).toContain('agent_changed_at');

    // The new constraints: a review outside the machine, and revise without the owner's note.
    await expect(
      client.query(`update plan_item set review = 'maybe' where id = $1`, [
        accepted,
      ]),
    ).rejects.toThrow(/plan_item_review_check/);
    await expect(
      client.query(`update plan_item set review = 'revise' where id = $1`, [
        accepted,
      ]),
    ).rejects.toThrow(/plan_item_owner_note_check/);
    await client.query(
      `update plan_item set review = 'revise', owner_note = 'darker' where id = $1`,
      [accepted],
    );

    // A rejection goes with its item.
    await insert(
      `insert into plan_item_rejection (plan_item_id, name, reason) values ($1, 'Chinos', 'too pale')`,
      [accepted],
    );
    await client.query(`delete from plan_item where id = $1`, [accepted]);
    const { rows: left } = await client.query(
      `select id from plan_item_rejection`,
    );
    expect(left).toEqual([]);
  });
});
