import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schemaDrift } from '../support/schema-drift';
import { createTestApp, TestApp } from './harness';

/**
 * Booting the app runs the Drizzle migrations (src/db/migrate.ts) on a fresh
 * database; the schema they leave behind must be exactly src/db/schema.ts.
 * The legacy path (a database built by MikroORM, as production's was) is
 * test/integration/migration-runner.spec.ts.
 */
describe('migrations', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('leaves no difference between src/db/schema.ts and the migrated schema', async () => {
    expect(await schemaDrift(t.db)).toEqual([]);
  });

  // The drift check compares against the schema file, so an index dropped
  // from both would pass it. Postgres does not index foreign keys on its
  // own: this list is what the queries rely on.
  it('creates the lookup and foreign-key indexes', async () => {
    const { rows } = await t.db.execute<{ name: string }>(
      sql`select indexname as name from pg_indexes where schemaname = current_schema()`,
    );
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'user_shareable_id_index',
        'file_shareable_id_index',
        'file_created_by_id_index',
        'garment_shareable_id_index',
        'garment_owner_id_index',
        'garment_category_index',
        'garment_photo_id_unique',
        'outfit_shareable_id_index',
        'outfit_owner_id_index',
        'outfit_garments_outfit_id_index',
        'outfit_garments_garment_id_index',
        // Also the (owner_id, day) index of the calendar's week queries.
        'outfit_calendar_owner_id_day_outfit_id_unique',
        'outfit_calendar_outfit_id_index',
        'user_device_user_id_index',
        'wardrobe_share_grantor_id_index',
        'wardrobe_share_grantee_id_index',
        'wardrobe_share_invite_token_unique',
      ]),
    );
  });

  // relations() are checked only when a relational query uses them; every
  // relation in the schema is walked once here.
  it('resolves every relation in the schema', async () => {
    await expect(
      Promise.all([
        t.db.query.user.findMany({
          with: {
            devices: true,
            fileUploads: true,
            garments: true,
            outfits: true,
            calendarEntries: true,
            sharesGranted: true,
            sharesReceived: true,
          },
        }),
        t.db.query.file.findMany({ with: { createdBy: true, garment: true } }),
        t.db.query.garment.findMany({
          with: { photo: true, owner: true, outfitGarments: true },
        }),
        t.db.query.outfit.findMany({
          with: { owner: true, outfitGarments: true, calendarEntries: true },
        }),
        t.db.query.outfitGarment.findMany({
          with: { outfit: true, garment: true },
        }),
        t.db.query.outfitCalendar.findMany({
          with: { outfit: true, owner: true },
        }),
        t.db.query.wardrobeShare.findMany({
          with: { grantor: true, grantee: true },
        }),
        t.db.query.userDevice.findMany({ with: { user: true } }),
      ]),
    ).resolves.toBeDefined();
    const owner = await t.db.query.user.findFirst({
      where: (user, { eq }) => eq(user.id, t.owner.id),
    });
    expect(owner?.email).toBe(t.owner.email);
  });
});
