import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MigrationFailedError, runMigrations } from '../../src/db/migrate';
import { applyLegacyMigrations } from '../support/legacy-migrations';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { silentLogger } from './logger';

/**
 * drizzle/0002_outfit_slot.sql on legacy-shaped data: outfits whose
 * composition lives in outfit.slots (JSON, as the builder posted it) and in
 * the outfit_garments pivot (what the pages rendered). Each case builds a
 * database with the legacy MikroORM migrations, as production's was, seeds
 * rows the way the MikroORM-era app wrote them, and runs the boot's
 * migration runner on it.
 */

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

/** The legacy schema's rows, inserted as MikroORM wrote them. */
class LegacySeed {
  private seq = 0;

  constructor(private readonly client: Client) {}

  async user(): Promise<number> {
    this.seq += 1;
    const { rows } = await this.client.query<{ id: number }>(
      `insert into "user" (shareable_id, email, password)
       values ($1, $2, 'x') returning id`,
      [`user-${this.seq}`, `user${this.seq}@example.com`],
    );
    return rows[0].id;
  }

  async garment(ownerId: number, category: string): Promise<number> {
    this.seq += 1;
    const { rows } = await this.client.query<{ id: number }>(
      `insert into garment (shareable_id, name, category, owner_id)
       values ($1, $2, $3, $4) returning id`,
      [`garment-${this.seq}`, `Garment ${this.seq}`, category, ownerId],
    );
    return rows[0].id;
  }

  /**
   * `slots` goes in as JSON text: an array, JSON null, or anything else a
   * damaged row might hold. `pivot` becomes outfit_garments rows.
   */
  async outfit(
    ownerId: number,
    slots: unknown,
    pivot: number[] = [],
  ): Promise<number> {
    this.seq += 1;
    const { rows } = await this.client.query<{ id: number }>(
      `insert into outfit (shareable_id, name, owner_id, slots)
       values ($1, $2, $3, $4::jsonb) returning id`,
      [
        `outfit-${this.seq}`,
        `Outfit ${this.seq}`,
        ownerId,
        slots === undefined ? null : JSON.stringify(slots),
      ],
    );
    const id = rows[0].id;
    for (const garmentId of pivot) {
      await this.client.query(
        'insert into outfit_garments (outfit_id, garment_id) values ($1, $2)',
        [id, garmentId],
      );
    }
    return id;
  }

  deleteGarment(id: number) {
    // The pivot row cascades; the JSON slot keeps the id (no foreign key).
    return this.client.query('delete from garment where id = $1', [id]);
  }
}

async function legacyDatabase<T>(
  seed: (seed: LegacySeed) => Promise<T>,
): Promise<{ env: Record<string, string>; seeded: T }> {
  const database = await createScratchDatabase('closet_it');
  databases.push(database);
  await applyLegacyMigrations(database.env);
  const seeded = await withClient(database.env, (client) =>
    seed(new LegacySeed(client)),
  );
  return { env: database.env, seeded };
}

type SlotRow = [category: string, garmentId: number | null];

/** outfit_slot rows per outfit, by position. */
const slotsByOutfit = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{
      outfit_id: number;
      position: number;
      category: string;
      garment_id: number | null;
    }>('select * from outfit_slot order by outfit_id, position');
    const byOutfit = new Map<number, SlotRow[]>();
    for (const row of rows) {
      const slots = byOutfit.get(row.outfit_id) ?? [];
      // Positions are dense from 0: the n-th row is position n.
      expect(row.position).toBe(slots.length);
      slots.push([row.category, row.garment_id]);
      byOutfit.set(row.outfit_id, slots);
    }
    return byOutfit;
  });

const tableExists = (env: Record<string, string>, table: string) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      'select to_regclass($1) is not null as exists',
      [table],
    );
    return rows[0].exists;
  });

const outfitColumns = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `select column_name as name from information_schema.columns
        where table_name = 'outfit' order by column_name`,
    );
    return rows.map((row) => row.name);
  });

const recordedMigrations = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    return rows[0].n;
  });

describe('outfit composition moves to outfit_slot (0002_outfit_slot)', () => {
  it('keeps the saved order, empty rows and repeated garments, then drops the old stores', async () => {
    const { env, seeded } = await legacyDatabase(async (seed) => {
      const owner = await seed.user();
      const top = await seed.garment(owner, 'tops');
      const pants = await seed.garment(owner, 'bottoms');
      const scarf = await seed.garment(owner, 'scarves');
      const built = await seed.outfit(
        owner,
        [
          { category: 'bottoms', garmentId: pants },
          { category: 'footwear', garmentId: null },
          { category: 'tops', garmentId: top },
          // The same garment in two rows is one pivot row.
          { category: 'scarves', garmentId: scarf },
          { category: 'scarves', garmentId: scarf },
        ],
        [top, pants, scarf],
      );
      const empty = await seed.outfit(owner, []);
      const nothing = await seed.outfit(owner, undefined);
      return { top, pants, scarf, built, empty, nothing };
    });

    await runMigrations(configOf(env), silentLogger);

    const slots = await slotsByOutfit(env);
    expect(slots.get(seeded.built)).toEqual([
      ['bottoms', seeded.pants],
      ['footwear', null],
      ['tops', seeded.top],
      ['scarves', seeded.scarf],
      ['scarves', seeded.scarf],
    ]);
    expect(slots.has(seeded.empty)).toBe(false);
    expect(slots.has(seeded.nothing)).toBe(false);
    expect(await tableExists(env, 'outfit_garments')).toBe(false);
    expect(await outfitColumns(env)).not.toContain('slots');
  });

  it('empties a slot whose garment is gone, is not the owner’s, or is not an id', async () => {
    const { env, seeded } = await legacyDatabase(async (seed) => {
      const owner = await seed.user();
      const stranger = await seed.user();
      const kept = await seed.garment(owner, 'tops');
      const deleted = await seed.garment(owner, 'bottoms');
      const theirs = await seed.garment(stranger, 'footwear');
      const outfit = await seed.outfit(
        owner,
        [
          { category: 'tops', garmentId: kept },
          { category: 'bottoms', garmentId: deleted },
          // Before the pivot filtered ids, a hand-made request could attach
          // someone else's garment; the pivot row is refused here too.
          { category: 'footwear', garmentId: theirs },
          { category: 'hats', garmentId: 1.5 },
          { category: 'hats', garmentId: 'abc' },
          { category: 'hats' },
        ],
        [kept, deleted, theirs],
      );
      await seed.deleteGarment(deleted);
      return { kept, outfit };
    });

    await runMigrations(configOf(env), silentLogger);

    expect((await slotsByOutfit(env)).get(seeded.outfit)).toEqual([
      ['tops', seeded.kept],
      ['bottoms', null],
      ['footwear', null],
      ['hats', null],
      ['hats', null],
      ['hats', null],
    ]);
  });

  it('builds slots from the pivot for outfits saved without any, by category then id', async () => {
    const { env, seeded } = await legacyDatabase(async (seed) => {
      const owner = await seed.user();
      const stranger = await seed.user();
      const topA = await seed.garment(owner, 'tops');
      const shoes = await seed.garment(owner, 'footwear');
      const topB = await seed.garment(owner, 'tops');
      const coat = await seed.garment(owner, 'coats');
      const theirs = await seed.garment(stranger, 'bags');
      const nullSlots = await seed.outfit(owner, undefined, [
        topB,
        shoes,
        topA,
        theirs,
      ]);
      const jsonNull = await seed.outfit(owner, null, [coat]);
      const emptyArray = await seed.outfit(owner, [], [shoes]);
      return { topA, topB, shoes, coat, nullSlots, jsonNull, emptyArray };
    });

    await runMigrations(configOf(env), silentLogger);

    const slots = await slotsByOutfit(env);
    expect(slots.get(seeded.nullSlots)).toEqual([
      ['footwear', seeded.shoes],
      ['tops', seeded.topA],
      ['tops', seeded.topB],
    ]);
    expect(slots.get(seeded.jsonNull)).toEqual([['coats', seeded.coat]]);
    expect(slots.get(seeded.emptyArray)).toEqual([['footwear', seeded.shoes]]);
  });

  it('aborts, changing nothing, when the pivot holds a garment the slots do not', async () => {
    const { env, seeded } = await legacyDatabase(async (seed) => {
      const owner = await seed.user();
      const top = await seed.garment(owner, 'tops');
      const pants = await seed.garment(owner, 'bottoms');
      const outfit = await seed.outfit(
        owner,
        [{ category: 'tops', garmentId: top }],
        [top, pants],
      );
      return { outfit };
    });

    const run = runMigrations(configOf(env), silentLogger);
    await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(run).rejects.toThrow(
      new RegExp(
        `1 outfit\\(s\\) \\(id ${seeded.outfit}\\) list different garments`,
      ),
    );

    // The batch (0001 and 0002, pending together on a legacy database)
    // rolled back: both old stores remain, only the baseline is recorded.
    expect(await tableExists(env, 'outfit_garments')).toBe(true);
    expect(await tableExists(env, 'outfit_slot')).toBe(false);
    expect(await outfitColumns(env)).toContain('slots');
    expect(await recordedMigrations(env)).toBe(1);
  });

  it('aborts when the slots name a garment the pivot does not', async () => {
    const { env } = await legacyDatabase(async (seed) => {
      const owner = await seed.user();
      const top = await seed.garment(owner, 'tops');
      const pants = await seed.garment(owner, 'bottoms');
      await seed.outfit(
        owner,
        [
          { category: 'tops', garmentId: top },
          { category: 'bottoms', garmentId: pants },
        ],
        [top],
      );
    });

    await expect(runMigrations(configOf(env), silentLogger)).rejects.toThrow(
      /list different garments/,
    );
    expect(await tableExists(env, 'outfit_garments')).toBe(true);
  });

  it('aborts on slots that are not an array of slots', async () => {
    const shapes: unknown[] = [
      { category: 'tops', garmentId: null },
      [{ garmentId: null }],
      ['tops'],
    ];
    for (const slots of shapes) {
      const { env } = await legacyDatabase(async (seed) => {
        await seed.outfit(await seed.user(), slots);
      });
      await expect(
        runMigrations(configOf(env), silentLogger),
        JSON.stringify(slots),
      ).rejects.toThrow(/outfit\.slots: 1 (row|slot)\(s\)/);
      expect(await outfitColumns(env)).toContain('slots');
    }
  });
});
