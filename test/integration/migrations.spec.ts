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
        // Share links and the watermark route look rows up by these.
        'file_shareable_id_unique',
        'garment_shareable_id_unique',
        'outfit_shareable_id_unique',
        'file_created_by_id_index',
        // The wardrobe grid's and the wishlist's keyset pages (also the
        // owner_id foreign key) and its category filter, which the outfit
        // builder shares; what a wishlist item replaces (its foreign key).
        'garment_owner_id_status_id_index',
        'garment_replaces_garment_id_index',
        'garment_owner_id_category_id_index',
        'garment_photo_id_unique',
        'outfit_owner_id_index',
        // Also the index of outfit_slot.outfit_id.
        'outfit_slot_pkey',
        'outfit_slot_garment_id_index',
        // Also the (owner_id, day) index of the calendar's week queries.
        'outfit_calendar_owner_id_day_outfit_id_unique',
        'outfit_calendar_outfit_id_index',
        'user_device_user_id_index',
        // Link imports' per-user cap (oldest first); also the user_id key's.
        'pending_photo_user_id_created_at_index',
        'wardrobe_share_grantor_id_index',
        'wardrobe_share_grantee_id_index',
        'wardrobe_share_invite_token_unique',
        // One name per owner, any case; also the owner_id foreign key's.
        'capsule_owner_id_lower_name_unique',
        // Also the index of capsule_garment.capsule_id.
        'capsule_garment_pkey',
        'capsule_garment_garment_id_index',
        // The wear counts (per garment, by day; also garment_id's foreign
        // key), an entry's wears (also outfit_calendar_id's), "Wore today"
        // once a day, and the owner_id foreign key.
        'garment_wear_garment_id_day_index',
        'garment_wear_outfit_calendar_id_garment_id_unique',
        'garment_wear_garment_id_day_single_unique',
        'garment_wear_owner_id_index',
        // The generator reads an owner's avoided pairs (also the owner_id
        // foreign key's); each garment's foreign key has its own.
        'generator_avoid_pkey',
        'generator_avoid_garment_a_id_index',
        'generator_avoid_garment_b_id_index',
        // Every MCP call looks its bearer token up by its hash; the profile
        // lists a user's tokens (also the user_id foreign key's).
        'personal_access_token_token_hash_unique',
        'personal_access_token_user_id_index',
        // Login and every email lookup compare lower(email).
        'user_lower_email_unique',
        // Wardrobe plans (#34): one name per owner, any case (also the
        // owner_id foreign key's); one active plan per owner; a plan's
        // items.
        'wardrobe_plan_owner_id_lower_name_unique',
        'wardrobe_plan_owner_id_active_unique',
        'plan_item_plan_id_index',
        // The week template (#16): a user's (also its user_id foreign
        // key's), one outfit for the day per weekday; a user's plans and a
        // plan's entries (their foreign keys); the re-plan's claims (also
        // the user_id foreign key's).
        'week_template_pkey',
        'week_template_user_id_weekday_day_unique',
        'week_plan_owner_id_index',
        'week_plan_entry_week_plan_id_index',
        'week_replan_pkey',
        // An item's candidates (also plan_item_id's foreign key), and a
        // wishlist item's plan items (garment_id's), #34b.
        'plan_item_candidate_pkey',
        'plan_item_candidate_garment_id_index',
        // Outfit selfies (#19): an entry's selfie (also outfit_calendar_id's
        // foreign key), a photo's selfie (the public /file route's refusal,
        // photo_id's), a week's detached looks (also owner_id's).
        'selfie_outfit_calendar_id_unique',
        'selfie_photo_id_unique',
        'selfie_owner_id_day_index',
        // Trips (#10): the list (also owner_id's), a trip's outfits once a
        // day or once undated (also trip_id's), an outfit's trips (the
        // packed marks' pruning; outfit_id's), extras once per label (also
        // trip_id's), packed marks (trip_id's) and a garment's (garment_id's).
        'trip_owner_id_starts_on_index',
        'trip_outfit_trip_id_outfit_id_day_unique',
        'trip_outfit_trip_id_outfit_id_undated_unique',
        'trip_outfit_outfit_id_index',
        'trip_item_trip_id_lower_label_unique',
        'trip_garment_packed_pkey',
        'trip_garment_packed_garment_id_index',
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
            accessTokens: true,
            fileUploads: true,
            garments: true,
            outfits: true,
            capsules: true,
            plans: true,
            trips: true,
            calendarEntries: true,
            sharesGranted: true,
            sharesReceived: true,
          },
        }),
        t.db.query.file.findMany({
          with: { createdBy: true, garment: true, selfie: true },
        }),
        t.db.query.selfie.findMany({
          with: { owner: true, entry: true, photo: true },
        }),
        t.db.query.garment.findMany({
          with: {
            photo: true,
            owner: true,
            outfitSlots: true,
            capsuleGarments: true,
            wears: true,
            planCandidacies: true,
          },
        }),
        t.db.query.outfit.findMany({
          with: {
            owner: true,
            slots: true,
            calendarEntries: true,
            trips: true,
          },
        }),
        t.db.query.outfitSlot.findMany({
          with: { outfit: true, garment: true },
        }),
        t.db.query.outfitCalendar.findMany({
          with: { outfit: true, owner: true, wears: true, selfie: true },
        }),
        t.db.query.garmentWear.findMany({
          with: { garment: true, entry: true },
        }),
        t.db.query.wardrobeShare.findMany({
          with: { grantor: true, grantee: true },
        }),
        t.db.query.userDevice.findMany({ with: { user: true } }),
        t.db.query.personalAccessToken.findMany({ with: { user: true } }),
        t.db.query.capsule.findMany({ with: { owner: true, garments: true } }),
        t.db.query.capsuleGarment.findMany({
          with: { capsule: true, garment: true },
        }),
        t.db.query.wardrobePlan.findMany({
          with: { owner: true, items: true },
        }),
        t.db.query.planItem.findMany({
          with: { plan: true, candidates: true },
        }),
        t.db.query.planItemCandidate.findMany({
          with: { item: true, garment: true },
        }),
        t.db.query.trip.findMany({
          with: { owner: true, outfits: true, items: true },
        }),
        t.db.query.tripOutfit.findMany({
          with: { trip: true, outfit: true },
        }),
        t.db.query.tripItem.findMany({ with: { trip: true } }),
      ]),
    ).resolves.toBeDefined();
    const owner = await t.db.query.user.findFirst({
      where: (user, { eq }) => eq(user.id, t.owner.id),
    });
    expect(owner?.email).toBe(t.owner.email);
  });
});
