import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MigrationFailedError, runMigrations } from '../../src/db/migrate';
import { applyLegacyMigrations } from '../support/legacy-migrations';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';

/**
 * drizzle/0004_garment_web.sql on data shaped like the old garment form's:
 * acquisition dates at UTC midnight, blank strings for cleared fields,
 * categories in any case, comma-joined colours with stray spaces. Each case
 * builds a database with the legacy MikroORM migrations, as production's
 * was, adds rows, and runs the boot's migration runner on it.
 */

const LOGGER = { info: () => undefined, error: () => undefined };

let databases: ScratchDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.map((database) => database.drop()));
  databases = [];
});

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

async function withClient<T>(
  env: Record<string, string>,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(connectionOptions(configOf(env)));
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** A garment row as the Nest garment form wrote it. */
interface LegacyGarment {
  name?: string | null;
  category?: string;
  brand?: string | null;
  size?: string | null;
  notes?: string | null;
  washingDetails?: string | null;
  color?: string | null;
  /** A timestamptz literal, as MikroORM stored it. */
  dateAquired?: string | null;
  shareableId?: string;
}

let seq = 0;

/** Every column of a seeded garment, before a case's own values. */
function legacyDefaults(n: number): Required<LegacyGarment> {
  return {
    shareableId: `garment-${n}`,
    name: null,
    category: 'tops',
    brand: null,
    size: null,
    notes: null,
    washingDetails: null,
    color: null,
    dateAquired: null,
  };
}

/**
 * A MikroORM-era database with one user owning `garments`, and one outfit
 * whose single slot names the first garment's category as typed. Returns its
 * env and the garment ids in order.
 */
async function legacyDatabase(garments: LegacyGarment[]) {
  const database = await createScratchDatabase('closet_it');
  databases.push(database);
  await applyLegacyMigrations(database.env);
  const ids = await withClient(database.env, async (client) => {
    const {
      rows: [owner],
    } = await client.query<{ id: number }>(
      `insert into "user" (shareable_id, email, password)
       values ('owner-share-id', 'owner@example.com', 'x') returning id`,
    );
    const inserted: number[] = [];
    for (const given of garments) {
      seq += 1;
      const row = { ...legacyDefaults(seq), ...given };
      const { rows } = await client.query<{ id: number }>(
        `insert into garment (shareable_id, name, category, brand, size, notes,
           washing_details, color, date_aquired, owner_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [
          row.shareableId,
          row.name,
          row.category,
          row.brand,
          row.size,
          row.notes,
          row.washingDetails,
          row.color,
          row.dateAquired,
          owner.id,
        ],
      );
      inserted.push(rows[0].id);
    }
    if (inserted.length > 0) {
      const slots = [
        { category: garments[0].category ?? 'tops', garmentId: inserted[0] },
      ];
      const {
        rows: [outfit],
      } = await client.query<{ id: number }>(
        `insert into outfit (shareable_id, name, owner_id, slots)
         values ('outfit-share-id', 'Look', $1, $2::jsonb) returning id`,
        [owner.id, JSON.stringify(slots)],
      );
      await client.query(
        'insert into outfit_garments (outfit_id, garment_id) values ($1, $2)',
        [outfit.id, inserted[0]],
      );
    }
    return inserted;
  });
  return { env: database.env, ids };
}

const garmentRows = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      // to_char: node-postgres would parse a date into a local-time Date.
      `select id, name, category, brand, size, notes, washing_details, color,
              to_char(acquired_on, 'YYYY-MM-DD') as acquired_on
         from garment order by id`,
    );
    return rows;
  });

const columnsOf = (env: Record<string, string>, table: string) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ name: string; type: string }>(
      `select column_name as name, data_type as type
         from information_schema.columns
        where table_name = $1 order by column_name`,
      [table],
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.type]));
  });

const recordedMigrations = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    return rows[0].n;
  });

describe('garments move to the web layer (0004_garment_web)', () => {
  it('keeps every acquisition day, whatever the session zone, and normalises what the old form stored', async () => {
    const { env, ids } = await legacyDatabase([
      {
        name: '  Linen blazer ',
        category: ' Tops ',
        brand: '',
        size: '',
        notes: '   ',
        washingDetails: '',
        color: ' red, ,blue',
        dateAquired: '2024-03-15T00:00:00Z',
      },
      // The spring-forward Sunday and a leap day, where a local-time
      // conversion would have slipped.
      { name: 'Coat', dateAquired: '2026-03-08T00:00:00Z', color: '' },
      { name: 'Scarf', dateAquired: '2028-02-29T00:00:00Z', color: 'green' },
      { name: '', notes: 'Kept as written  ' },
    ]);
    await withClient(env, (client) =>
      client.query(
        `alter database "${env.DATABASE_SCHEMA}" set timezone to 'America/New_York'`,
      ),
    );

    await runMigrations(configOf(env), LOGGER);

    expect(await garmentRows(env)).toEqual([
      {
        id: ids[0],
        name: 'Linen blazer',
        category: 'tops',
        brand: null,
        size: null,
        notes: null,
        washing_details: null,
        color: 'red,blue',
        acquired_on: '2024-03-15',
      },
      expect.objectContaining({
        id: ids[1],
        color: null,
        acquired_on: '2026-03-08',
      }),
      expect.objectContaining({
        id: ids[2],
        color: 'green',
        acquired_on: '2028-02-29',
      }),
      expect.objectContaining({
        id: ids[3],
        name: null,
        notes: 'Kept as written  ',
        acquired_on: null,
      }),
    ]);
    // The outfit's slot follows its garment's category.
    const slots = await withClient(env, async (client) => {
      const { rows } = await client.query<{ category: string }>(
        'select category from outfit_slot',
      );
      return rows.map((row) => row.category);
    });
    expect(slots).toEqual(['tops']);

    expect(await columnsOf(env, 'garment')).toEqual({
      acquired_on: 'date',
      archived: 'boolean',
      brand: 'text',
      category: 'text',
      color: 'text',
      id: 'integer',
      name: 'text',
      notes: 'text',
      owner_id: 'integer',
      photo_id: 'integer',
      shareable_id: 'character varying',
      size: 'text',
      washing_details: 'text',
    });
    expect(Object.keys(await columnsOf(env, 'user')).sort()).toEqual([
      'email',
      'first_name',
      'id',
      'last_name',
      'password',
    ]);
    expect(Object.keys(await columnsOf(env, 'file')).sort()).toEqual([
      'created_by_id',
      'created_on',
      'file_name',
      'id',
      'shareable_id',
      'version',
    ]);
    expect(Object.keys(await columnsOf(env, 'outfit')).sort()).toEqual([
      'id',
      'name',
      'notes',
      'owner_id',
      'shareable_id',
    ]);

    // Share ids are unique now.
    await expect(
      withClient(env, (client) =>
        client.query(
          `update garment set shareable_id = (select shareable_id from garment where id = $1) where id = $2`,
          [ids[0], ids[1]],
        ),
      ),
    ).rejects.toThrow(/garment_shareable_id_unique/);
  });

  it('aborts on an acquisition date that is not UTC midnight, changing nothing', async () => {
    const { env } = await legacyDatabase([
      { name: 'Fine', dateAquired: '2024-03-15T00:00:00Z' },
      { name: 'Shifted', dateAquired: '2024-03-15T04:00:00Z' },
    ]);

    const run = runMigrations(configOf(env), LOGGER);
    await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(run).rejects.toThrow(
      /1 row\(s\) have a date_aquired that is not UTC midnight/,
    );
    // The whole batch rolled back: the legacy column, nothing recorded past
    // the baseline, and the normalisation undone.
    expect(await columnsOf(env, 'garment')).toMatchObject({
      date_aquired: 'timestamp with time zone',
      name: 'character varying',
    });
    expect(await recordedMigrations(env)).toBe(1);
  });

  it('aborts rather than drop a colour the old form let someone type', async () => {
    const { env } = await legacyDatabase([
      { name: 'Scarf', color: 'red,Teal' },
      { name: 'Hat', color: 'mauve' },
    ]);

    await expect(runMigrations(configOf(env), LOGGER)).rejects.toThrow(
      /colours outside the built-in set \(Teal, mauve\)/,
    );
    expect(await columnsOf(env, 'garment')).toMatchObject({
      color: 'character varying',
    });
  });

  it('aborts on a blank category', async () => {
    const { env } = await legacyDatabase([{ name: 'Nothing', category: ' ' }]);

    await expect(runMigrations(configOf(env), LOGGER)).rejects.toThrow(
      /1 row\(s\) have a blank category/,
    );
  });

  it('aborts on a share id two garments hold', async () => {
    const { env } = await legacyDatabase([
      { name: 'One', shareableId: 'same' },
      { name: 'Two', shareableId: 'same' },
    ]);

    await expect(runMigrations(configOf(env), LOGGER)).rejects.toThrow(
      /1 duplicate shareable_id value\(s\)/,
    );
  });
});
