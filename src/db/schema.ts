import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { CUTOUT_STATUSES } from '../cutout/state';
import {
  DEFAULT_OCCASION,
  type Occasion,
  OCCASIONS,
} from '../wardrobe/occasions';
import {
  AWAY_REASONS,
  type AwayReason,
  QUANTITY_MAX,
  WASH_AFTER_CHOICES,
} from '../wardrobe/availability';
import { GARMENT_STATUSES, type GarmentStatus } from '../wardrobe/status';
import {
  ALL_GARMENT_TYPES,
  type Condition,
  CONDITIONS,
  FABRIC_WEIGHT_GSM,
  type Fit,
  FITS,
  type Formality,
  FORMALITIES,
  type Length,
  LENGTHS,
  type Material,
  MATERIALS,
  type Pattern,
  PATTERNS,
  type Sleeve,
  SLEEVES,
  type Warmth,
  WARMTHS,
} from '../wardrobe/properties';

/**
 * The database schema, and the only source of migrations: edit it, run
 * `npx drizzle-kit generate`, review the SQL in drizzle/ (see CLAUDE.md,
 * Changing the schema). Introspected from the schema the legacy MikroORM
 * migrations built, so every constraint and index keeps the name MikroORM
 * gave it (`<table>_<column>_index`, `_unique`, `_foreign`); new ones should
 * follow the same pattern.
 *
 * Older columns hold what MikroORM wrote (varchar(255) where nothing longer
 * fits, timestamptz instants); free text a person types is `text`, bounded
 * by the route that writes it, not by the column. Foreign keys cascade on
 * update and (except garment.photo_id and outfit_slot.garment_id) on delete.
 * Postgres does not index foreign keys on its own, so every FK column has an
 * explicit index (or leads a composite one). Calendar days (a planned day,
 * an acquisition date) are `date` columns read as 'YYYY-MM-DD' strings.
 */

/**
 * A check constraint's list of literals, inlined (constraints take no
 * parameters). Only for the code's own constant lists: the values are
 * quoted, never escaped, so nothing a person typed may reach it.
 */
function sqlList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

export const user = pgTable(
  'user',
  {
    id: serial('id').primaryKey(),
    firstName: varchar('first_name', { length: 255 }),
    lastName: varchar('last_name', { length: 255 }),
    // Stored lower case (normalizeEmail); unique case-insensitively, the
    // way every lookup compares it (drizzle/0005_email_lower_outfit_text.sql).
    email: varchar('email', { length: 255 }),
    // bcrypt hash.
    password: varchar('password', { length: 255 }).notNull(),
  },
  (table) => [
    uniqueIndex('user_lower_email_unique').on(sql`lower(${table.email})`),
  ],
);

// One row per browser push subscription (Web Push, src/web/push/). The
// endpoint is the browser's identity across accounts: a browser that signs in
// as someone else, or renews its keys, keeps its row and changes owner or keys
// (upsertDevice). A row goes with its user, on unsubscribe, and when the push
// service answers 404/410 for its endpoint.
export const userDevice = pgTable(
  'user_device',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull(),
    // The push service's URL for this browser; Firefox's run past 255
    // characters, hence text.
    pushEndpoint: text('push_endpoint').notNull(),
    // The subscription's keys (RFC 8291), base64url: the browser's P-256
    // public key and the auth secret the payload is encrypted to.
    keyP256dh: text('key_p256dh').notNull(),
    keyAuth: text('key_auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // When the browser last confirmed the subscription: every signed-in app
    // start sends it again (public/js/push.js).
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('user_device_user_id_index').on(table.userId),
    foreignKey({
      name: 'user_device_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    unique('user_device_push_endpoint_unique').on(table.pushEndpoint),
  ],
);

// A personal access token (#33): a bearer credential for the MCP endpoint
// (src/web/mcp) that acts as its user. Only the token's SHA-256 is stored
// (src/web/auth/personal-tokens.ts): the token is 256 random bits, so a fast
// hash is enough and the lookup is this unique index. `token_prefix` is what
// the profile shows to tell tokens apart. Revoked rows stay (revoked_at), so
// the list can still name them; a new password revokes them all.
export const personalAccessToken = pgTable(
  'personal_access_token',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull(),
    name: text('name').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Written at most once a minute per token (authenticateToken).
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('personal_access_token_token_hash_unique').on(table.tokenHash),
    index('personal_access_token_user_id_index').on(table.userId),
    foreignKey({
      name: 'personal_access_token_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// One row per stored photo set (the original's name; see CLAUDE.md, Images).
export const file = pgTable(
  'file',
  {
    id: serial('id').primaryKey(),
    // A random UUID addressing the photo's share preview
    // (/file/watermark/:shareableId), set by the app on insert.
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    // An ISO timestamp as text, as MikroORM wrote it.
    createdOn: varchar('created_on', { length: 255 }).notNull(),
    createdById: integer('created_by_id').notNull(),
    // Cache-busting token of the immutable /file/** URLs, bumped whenever a
    // variant's bytes are rewritten in place.
    version: integer('version').default(1).notNull(),
    // The server-made cutout's state machine (src/cutout/state.ts), written
    // only by applyCutoutEvent (src/cutout/queries.ts). Pending rows are the
    // background-removal queue, oldest cutout_requested_at first.
    cutoutStatus: text('cutout_status', { enum: CUTOUT_STATUSES })
      .default('none')
      .notNull(),
    cutoutAttempts: integer('cutout_attempts').default(0).notNull(),
    // The photo version the running job started for; a result for any
    // other version is discarded.
    cutoutJobVersion: integer('cutout_job_version'),
    cutoutRequestedAt: timestamp('cutout_requested_at', {
      withTimezone: true,
    }),
  },
  (table) => [
    index('file_created_by_id_index').on(table.createdById),
    check(
      'file_cutout_status_check',
      sql`${table.cutoutStatus} in (${sqlList(CUTOUT_STATUSES)})`,
    ),
    uniqueIndex('file_shareable_id_unique').on(table.shareableId),
    foreignKey({
      name: 'file_created_by_id_foreign',
      columns: [table.createdById],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    unique('file_file_name_unique').on(table.fileName),
  ],
);

// A link import's photo stored before its garment form is saved (bytes
// only, no `file` row): bound to the user who fetched it, who alone may
// claim or discard it, and at most MAX_PENDING_PER_USER of them per user.
// The save deletes the row with the `file` row's insert; reconciliation
// removes day-old ones with their bytes, outside its deletion guard
// (src/web/files/pending-photos.ts, src/maintenance/reconcile.ts).
export const pendingPhoto = pgTable(
  'pending_photo',
  {
    fileName: varchar('file_name', { length: 255 }).primaryKey(),
    userId: integer('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The per-user cap's oldest-first eviction; also the foreign key's.
    index('pending_photo_user_id_created_at_index').on(
      table.userId,
      table.createdAt,
    ),
    foreignKey({
      name: 'pending_photo_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

export const garment = pgTable(
  'garment',
  {
    id: serial('id').primaryKey(),
    // A random UUID for share links (/share?shareableId=), set on insert.
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    // Free text, trimmed, null when blank (src/web/wardrobe/validation.ts).
    name: text('name'),
    // Trimmed and lower case: the filter value and the outfit builder's key.
    category: text('category').notNull(),
    brand: text('brand'),
    size: text('size'),
    notes: text('notes'),
    photoId: integer('photo_id'),
    ownerId: integer('owner_id').notNull(),
    // Comma-joined GarmentColor values ("red,blue"), only ever enum names
    // (the garment form validates them); null for none.
    color: text('color'),
    // The day the garment was acquired, not an instant (was date_aquired
    // timestamptz at UTC midnight until drizzle/0004_garment_web.sql).
    acquiredOn: date('acquired_on', { mode: 'string' }),
    washingDetails: text('washing_details'),
    // Wanted, owned or owned once (src/wardrobe/status.ts, the state
    // machine): written at insert (closet or wishlist) and changed only by
    // setGarmentStatus (src/web/wardrobe/status.ts). Every closet read goes
    // through inCloset there. Was `archived boolean` until
    // drizzle/0014_garment_status.sql.
    status: text('status').$type<GarmentStatus>().default('closet').notNull(),
    // A wishlist item's "this replaces": a garment of the same owner, owned
    // now or once (never a wishlist item, never itself). The same-owner rule
    // is the writers' (replacementOf, src/web/wardrobe/queries.ts), in the
    // statement that stores it; deleting the replaced garment clears it. Kept
    // after "Bought it" as the record of what the purchase replaced.
    replacesGarmentId: integer('replaces_garment_id'),
    // The properties (src/wardrobe/properties.ts, which owns every value
    // set these checks list). All optional; a save stores null for one
    // outside the garment's role, and a type only ever belongs to the
    // garment's category (the code's rule: a type may appear under two).
    type: text('type'),
    warmth: smallint('warmth').$type<Warmth>(),
    formality: smallint('formality').$type<Formality>(),
    // A set, no repeats, null for none (never an empty array).
    materials: text('materials').array().$type<Material[]>(),
    pattern: text('pattern').$type<Pattern>(),
    fit: text('fit').$type<Fit>(),
    sleeve: text('sleeve').$type<Sleeve>(),
    length: text('length').$type<Length>(),
    // Grams per square metre; entered and shown in oz too.
    fabricWeight: smallint('fabric_weight'),
    waterResistant: boolean('water_resistant').default(false).notNull(),
    // Where it can be bought: an http(s) product page (readProductFields,
    // src/web/wardrobe/validation.ts; the check is the backstop), shown as
    // "View product". Written by the garment form and the seed; link import
    // (#6) fills both from the page.
    sourceUrl: text('source_url'),
    // What it cost, in the household's currency; a string in TypeScript
    // ('24.90'), so no cent is lost to a float.
    price: numeric('price', { precision: 10, scale: 2 }),
    // Identical copies (three white tees are one garment, quantity 3). The
    // wash rules count copies (src/wardrobe/availability.ts).
    quantity: smallint('quantity').default(1).notNull(),
    // Wears a copy takes before it needs a wash; null is the role's
    // default, NEVER_WASH (0) never. Written by the garment form.
    washAfterWears: smallint('wash_after_wears'),
    // The day it was last washed (the household's date, APP_TIMEZONE):
    // wears after it count toward the next wash. Written only by
    // markWashed (src/web/wears/queries.ts); no history is kept.
    lastWashedOn: date('last_washed_on', { mode: 'string' }),
    // Out of the closet for now (lent, at the repair shop), and a word on
    // where; a manual state, never derived. The owner's own record, like
    // wears: setAway (src/web/wears/queries.ts) is its writer.
    away: text('away').$type<AwayReason>(),
    awayNote: text('away_note'),
    // What shape it is in (src/wardrobe/properties.ts CONDITIONS); a garment
    // property like the others (owner and MANAGE write it), and never part
    // of availability. The note says what is wrong, so only with a problem.
    condition: text('condition').$type<Condition>().default('good').notNull(),
    conditionNote: text('condition_note'),
  },
  (table) => [
    check(
      'garment_type_check',
      sql`${table.type} in (${sqlList(ALL_GARMENT_TYPES)})`,
    ),
    check(
      'garment_warmth_check',
      sql`${table.warmth} in (${sql.raw(WARMTHS.join(', '))})`,
    ),
    check(
      'garment_formality_check',
      sql`${table.formality} in (${sql.raw(FORMALITIES.join(', '))})`,
    ),
    check(
      'garment_materials_check',
      sql`${table.materials} <@ array[${sqlList(MATERIALS)}]::text[] and cardinality(${table.materials}) > 0`,
    ),
    check(
      'garment_pattern_check',
      sql`${table.pattern} in (${sqlList(PATTERNS)})`,
    ),
    check('garment_fit_check', sql`${table.fit} in (${sqlList(FITS)})`),
    check(
      'garment_sleeve_check',
      sql`${table.sleeve} in (${sqlList(SLEEVES)})`,
    ),
    check(
      'garment_length_check',
      sql`${table.length} in (${sqlList(LENGTHS)})`,
    ),
    check('garment_source_url_check', sql`${table.sourceUrl} ~* '^https?://'`),
    check('garment_price_check', sql`${table.price} >= 0`),
    check(
      'garment_quantity_check',
      sql`${table.quantity} between 1 and ${sql.raw(String(QUANTITY_MAX))}`,
    ),
    check(
      'garment_wash_after_wears_check',
      sql`${table.washAfterWears} between 0 and ${sql.raw(String(Math.max(...WASH_AFTER_CHOICES)))}`,
    ),
    check(
      'garment_away_check',
      sql`${table.away} in (${sqlList(AWAY_REASONS)})`,
    ),
    check(
      'garment_away_note_check',
      sql`${table.awayNote} is null or ${table.away} is not null`,
    ),
    check(
      'garment_condition_check',
      sql`${table.condition} in (${sqlList(CONDITIONS)})`,
    ),
    check(
      'garment_condition_note_check',
      sql`${table.conditionNote} is null or ${table.condition} <> 'good'`,
    ),
    check(
      'garment_fabric_weight_check',
      sql`${table.fabricWeight} between ${sql.raw(String(FABRIC_WEIGHT_GSM.min))} and ${sql.raw(String(FABRIC_WEIGHT_GSM.max))}`,
    ),
    check(
      'garment_status_check',
      sql`${table.status} in (${sqlList(GARMENT_STATUSES)})`,
    ),
    check(
      'garment_replaces_garment_id_check',
      sql`${table.replacesGarmentId} <> ${table.id}`,
    ),
    // The wardrobe grid's keyset pages: owner_id = ? AND status = 'closet'
    // [AND id < cursor] ORDER BY id DESC LIMIT n, read in index order; the
    // wishlist page the same with 'wishlist'. Also the index of the
    // owner_id foreign key.
    index('garment_owner_id_status_id_index').on(
      table.ownerId,
      table.status,
      table.id.desc(),
    ),
    // The grid's category filter and the outfit builder's category cycles
    // (owner, category, newest first; the status is a filter on top).
    index('garment_owner_id_category_id_index').on(
      table.ownerId,
      table.category,
      table.id.desc(),
    ),
    uniqueIndex('garment_shareable_id_unique').on(table.shareableId),
    foreignKey({
      name: 'garment_photo_id_foreign',
      columns: [table.photoId],
      foreignColumns: [file.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
    foreignKey({
      name: 'garment_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // Also the index for the photo_id foreign key.
    unique('garment_photo_id_unique').on(table.photoId),
    // The garment page's "on the wishlist to replace this" and the foreign
    // key's own index.
    index('garment_replaces_garment_id_index').on(table.replacesGarmentId),
    foreignKey({
      name: 'garment_replaces_garment_id_foreign',
      columns: [table.replacesGarmentId],
      foreignColumns: [table.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
  ],
);

export const outfit = pgTable(
  'outfit',
  {
    id: serial('id').primaryKey(),
    // A random UUID for share links (/share?shareableId=), set on insert.
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    name: text('name'),
    notes: text('notes'),
    ownerId: integer('owner_id').notNull(),
  },
  (table) => [
    index('outfit_owner_id_index').on(table.ownerId),
    uniqueIndex('outfit_shareable_id_unique').on(table.shareableId),
    foreignKey({
      name: 'outfit_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// What an outfit wears: one row per builder row, in the order the user built
// it (position 0 first). A slot names a category and optionally a garment; an
// empty slot is a row kept without a choice. The one store of composition
// since drizzle/0002_outfit_slot.sql replaced outfit.slots (JSON) and the
// outfit_garments pivot, which disagreed. garment_id is only ever a garment
// of the outfit's owner (the outfit form drops any other id). Deleting the
// garment empties the slot; archiving it changes nothing here.
export const outfitSlot = pgTable(
  'outfit_slot',
  {
    outfitId: integer('outfit_id').notNull(),
    position: smallint('position').notNull(),
    category: text('category').notNull(),
    garmentId: integer('garment_id'),
  },
  (table) => [
    // Also the index of the outfit_id foreign key.
    primaryKey({
      name: 'outfit_slot_pkey',
      columns: [table.outfitId, table.position],
    }),
    index('outfit_slot_garment_id_index').on(table.garmentId),
    foreignKey({
      name: 'outfit_slot_outfit_id_foreign',
      columns: [table.outfitId],
      foreignColumns: [outfit.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'outfit_slot_garment_id_foreign',
      columns: [table.garmentId],
      foreignColumns: [garment.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
  ],
);

// An outfit planned for a day and an occasion (the part of the day, #13).
// One row per (owner, day, outfit): scheduling is idempotent (POST /calendar
// and the outfit form insert ... on conflict do nothing), and the same
// outfit is never on one day twice, even for two occasions; different
// outfits on one day are fine.
export const outfitCalendar = pgTable(
  'outfit_calendar',
  {
    id: serial('id').primaryKey(),
    // A calendar day, not an instant: 'YYYY-MM-DD' end to end
    // (src/web/calendar/calendar-date.ts). Was `date timestamptz` at UTC
    // midnight until drizzle/0001_calendar_day.sql.
    day: date('day', { mode: 'string' }).notNull(),
    outfitId: integer('outfit_id').notNull(),
    ownerId: integer('owner_id').notNull(),
    // Null until the entry is marked worn.
    wornAt: timestamp('worn_at', { withTimezone: true }),
    // src/wardrobe/occasions.ts OCCASIONS; entries from before #13 are all day.
    occasion: text('occasion')
      .$type<Occasion>()
      .default(DEFAULT_OCCASION)
      .notNull(),
  },
  (table) => [
    check(
      'outfit_calendar_occasion_check',
      sql`${table.occasion} in (${sqlList(OCCASIONS)})`,
    ),
    // Leads with owner_id and day, so it is also the index of the week and
    // month range queries and of the owner_id foreign key.
    unique('outfit_calendar_owner_id_day_outfit_id_unique').on(
      table.ownerId,
      table.day,
      table.outfitId,
    ),
    index('outfit_calendar_outfit_id_index').on(table.outfitId),
    foreignKey({
      name: 'outfit_calendar_outfit_id_foreign',
      columns: [table.outfitId],
      foreignColumns: [outfit.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'outfit_calendar_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// One garment worn on one day: the wear log that outfit edits cannot
// rewrite (docs/plans/2026-09-26-wardrobe-features.md, section 1). Written
// only by src/web/wears/queries.ts: setEntryWorn snapshots a calendar
// entry's garments when it is marked worn (outfit_calendar_id set; unmarking
// or deleting the entry takes exactly its rows), setWoreToday logs one
// garment alone (outfit_calendar_id null). Counts are distinct days, never
// rows: two entries on one day are one wear. The owner's own record, like
// outfits and the calendar: shares never reach it.
export const garmentWear = pgTable(
  'garment_wear',
  {
    id: serial('id').primaryKey(),
    garmentId: integer('garment_id').notNull(),
    ownerId: integer('owner_id').notNull(),
    // The day worn, not an instant ('YYYY-MM-DD', APP_TIMEZONE's date).
    day: date('day', { mode: 'string' }).notNull(),
    outfitCalendarId: integer('outfit_calendar_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One entry counts a garment once (an outfit may hold it in two
    // slots). Also the index of the outfit_calendar_id foreign key.
    unique('garment_wear_outfit_calendar_id_garment_id_unique').on(
      table.outfitCalendarId,
      table.garmentId,
    ),
    // "Wore today" once a day: the single-garment wears (no entry).
    uniqueIndex('garment_wear_garment_id_day_single_unique')
      .on(table.garmentId, table.day)
      .where(sql`${table.outfitCalendarId} is null`),
    // The counts (per garment, days after the last wash). Also the index of
    // the garment_id foreign key.
    index('garment_wear_garment_id_day_index').on(table.garmentId, table.day),
    // The owner_id foreign key's (an account's deletion cascades by it).
    index('garment_wear_owner_id_index').on(table.ownerId),
    foreignKey({
      name: 'garment_wear_garment_id_foreign',
      columns: [table.garmentId],
      foreignColumns: [garment.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'garment_wear_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'garment_wear_outfit_calendar_id_foreign',
      columns: [table.outfitCalendarId],
      foreignColumns: [outfitCalendar.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// A named subset of one owner's garments (office, weekend, a trip's pool;
// src/web/capsules). The closet itself is never a row: it is every
// unarchived garment, what every page shows without a capsule. Part of the
// wardrobe, so a share reaches it (resolveWardrobeAccess): a grantee views
// the grantor's capsules, a MANAGE grantee edits their membership, only
// the owner creates, renames and deletes them.
export const capsule = pgTable(
  'capsule',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    // Trimmed, never blank; bounded by the route (CAPSULE_NAME_MAX); one
    // per owner whatever the case (capsule_owner_id_lower_name_unique).
    name: text('name').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // "Office" once per wardrobe, compared as the list sorts it; the
    // writers answer a violation as 'name-taken'. Also the index of the
    // owner_id foreign key and of every capsule query (owner first).
    // owner_id is written as an expression on purpose: drizzle-kit's
    // introspection marks every column of an index with any expression as
    // one, so a plain column here reads back as drift (the drift test).
    uniqueIndex('capsule_owner_id_lower_name_unique').on(
      sql`${table.ownerId}`,
      sql`lower(${table.name})`,
    ),
    foreignKey({
      name: 'capsule_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// A capsule's garments. Only ever a garment of the capsule's owner: the one
// writer, changeMembership (src/web/capsules/queries.ts), drops any other
// id, which is also what makes the grid's capsule filter safe to apply to
// any wardrobe. Archiving a garment keeps its membership (the capsule's
// views leave it out, like every other view); deleting either side
// deletes the row.
export const capsuleGarment = pgTable(
  'capsule_garment',
  {
    capsuleId: integer('capsule_id').notNull(),
    garmentId: integer('garment_id').notNull(),
  },
  (table) => [
    // Also the index of the capsule_id foreign key.
    primaryKey({
      name: 'capsule_garment_pkey',
      columns: [table.capsuleId, table.garmentId],
    }),
    index('capsule_garment_garment_id_index').on(table.garmentId),
    foreignKey({
      name: 'capsule_garment_capsule_id_foreign',
      columns: [table.capsuleId],
      foreignColumns: [capsule.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'capsule_garment_garment_id_foreign',
      columns: [table.garmentId],
      foreignColumns: [garment.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

/** What a wardrobe share lets the grantee do: read, or read and write. */
export type SharePermission = 'VIEW' | 'MANAGE';

// A grantor's wardrobe shared with a grantee. A pending invite has an
// invite_token and no grantee yet.
export const wardrobeShare = pgTable(
  'wardrobe_share',
  {
    id: serial('id').primaryKey(),
    grantorId: integer('grantor_id').notNull(),
    granteeId: integer('grantee_id'),
    // Typed in TypeScript only ($type): the column is plain varchar, and
    // every write goes through a validated SharePermission.
    permission: varchar('permission', { length: 255 })
      .$type<SharePermission>()
      .default('VIEW')
      .notNull(),
    inviteToken: varchar('invite_token', { length: 255 }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('wardrobe_share_grantee_id_index').on(table.granteeId),
    index('wardrobe_share_grantor_id_index').on(table.grantorId),
    foreignKey({
      name: 'wardrobe_share_grantor_id_foreign',
      columns: [table.grantorId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'wardrobe_share_grantee_id_foreign',
      columns: [table.granteeId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // Also the acceptInvite lookup index.
    unique('wardrobe_share_invite_token_unique').on(table.inviteToken),
    unique('wardrobe_share_grantor_id_grantee_id_unique').on(
      table.grantorId,
      table.granteeId,
    ),
  ],
);

// Relations for db.query (relational queries); they add nothing to the
// schema. Names follow the MikroORM entities' properties.

export const userRelations = relations(user, ({ many }) => ({
  devices: many(userDevice),
  accessTokens: many(personalAccessToken),
  fileUploads: many(file),
  garments: many(garment),
  outfits: many(outfit),
  capsules: many(capsule),
  calendarEntries: many(outfitCalendar),
  sharesGranted: many(wardrobeShare, { relationName: 'grantor' }),
  sharesReceived: many(wardrobeShare, { relationName: 'grantee' }),
}));

export const personalAccessTokenRelations = relations(
  personalAccessToken,
  ({ one }) => ({
    user: one(user, {
      fields: [personalAccessToken.userId],
      references: [user.id],
    }),
  }),
);

export const userDeviceRelations = relations(userDevice, ({ one }) => ({
  user: one(user, { fields: [userDevice.userId], references: [user.id] }),
}));

export const fileRelations = relations(file, ({ one }) => ({
  createdBy: one(user, { fields: [file.createdById], references: [user.id] }),
  // At most one: garment.photo_id is unique.
  garment: one(garment),
}));

export const garmentRelations = relations(garment, ({ one, many }) => ({
  photo: one(file, { fields: [garment.photoId], references: [file.id] }),
  owner: one(user, { fields: [garment.ownerId], references: [user.id] }),
  outfitSlots: many(outfitSlot),
  capsuleGarments: many(capsuleGarment),
  wears: many(garmentWear),
}));

export const garmentWearRelations = relations(garmentWear, ({ one }) => ({
  garment: one(garment, {
    fields: [garmentWear.garmentId],
    references: [garment.id],
  }),
  entry: one(outfitCalendar, {
    fields: [garmentWear.outfitCalendarId],
    references: [outfitCalendar.id],
  }),
}));

export const capsuleRelations = relations(capsule, ({ one, many }) => ({
  owner: one(user, { fields: [capsule.ownerId], references: [user.id] }),
  garments: many(capsuleGarment),
}));

export const capsuleGarmentRelations = relations(capsuleGarment, ({ one }) => ({
  capsule: one(capsule, {
    fields: [capsuleGarment.capsuleId],
    references: [capsule.id],
  }),
  garment: one(garment, {
    fields: [capsuleGarment.garmentId],
    references: [garment.id],
  }),
}));

export const outfitRelations = relations(outfit, ({ one, many }) => ({
  owner: one(user, { fields: [outfit.ownerId], references: [user.id] }),
  slots: many(outfitSlot),
  calendarEntries: many(outfitCalendar),
}));

export const outfitSlotRelations = relations(outfitSlot, ({ one }) => ({
  outfit: one(outfit, {
    fields: [outfitSlot.outfitId],
    references: [outfit.id],
  }),
  garment: one(garment, {
    fields: [outfitSlot.garmentId],
    references: [garment.id],
  }),
}));

export const outfitCalendarRelations = relations(
  outfitCalendar,
  ({ one, many }) => ({
    outfit: one(outfit, {
      fields: [outfitCalendar.outfitId],
      references: [outfit.id],
    }),
    owner: one(user, {
      fields: [outfitCalendar.ownerId],
      references: [user.id],
    }),
    wears: many(garmentWear),
  }),
);

export const wardrobeShareRelations = relations(wardrobeShare, ({ one }) => ({
  grantor: one(user, {
    fields: [wardrobeShare.grantorId],
    references: [user.id],
    relationName: 'grantor',
  }),
  grantee: one(user, {
    fields: [wardrobeShare.granteeId],
    references: [user.id],
    relationName: 'grantee',
  }),
}));
