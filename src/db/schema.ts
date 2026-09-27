import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
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
  type MinuteOfDay,
  REMINDER_KINDS,
  REMINDER_STEP_MINUTES,
  REMINDER_WINDOWS,
  type ReminderKind,
} from '../push/reminders';
import type { Forecast } from '../weather/forecast';
import {
  DEFAULT_TEMPERATURE_UNIT,
  OFFSET_LIMIT,
  TEMPERATURE_UNITS,
} from '../weather/temperature';
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
import { PLAN_PRIORITIES, type PlanPriority } from '../wardrobe/plans';
import { GARMENT_STATUSES, type GarmentStatus } from '../wardrobe/status';
import {
  type BudgetBand,
  BUDGET_BANDS,
  RHYTHM_PERIODS,
  RHYTHM_TIMES_MAX,
  type RhythmPeriod,
  type Style,
  STYLES,
} from '../wardrobe/style';
import {
  ALL_GARMENT_TYPES,
  type Condition,
  CONDITIONS,
  FABRIC_WEIGHT_GSM,
  type Fit,
  FITS,
  type Formality,
  FORMALITIES,
  GARMENT_COLORS,
  type GarmentColor,
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

/**
 * The unique constraints a writer answers a violation of with a message
 * (isUniqueViolation, src/db/errors.ts), each named once here and used by
 * both the index below and the writer that catches it. Only these: a
 * violation of any other constraint is a bug to surface, never a message.
 */
export const USER_EMAIL_UNIQUE = 'user_lower_email_unique';
export const CAPSULE_NAME_UNIQUE = 'capsule_owner_id_lower_name_unique';
export const PLAN_NAME_UNIQUE = 'wardrobe_plan_owner_id_lower_name_unique';
export const SHARE_GRANTEE_UNIQUE =
  'wardrobe_share_grantor_id_grantee_id_unique';
export type UniqueConstraint =
  | typeof USER_EMAIL_UNIQUE
  | typeof CAPSULE_NAME_UNIQUE
  | typeof PLAN_NAME_UNIQUE
  | typeof SHARE_GRANTEE_UNIQUE;

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
  (table) => [uniqueIndex(USER_EMAIL_UNIQUE).on(sql`lower(${table.email})`)],
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
    // This device's push reminders (#15, src/push/reminders.ts): the minute
    // of the day in APP_TIMEZONE each is sent at, null when off (opt-in,
    // per device). `reminders_set_at` is when they were last saved: a
    // reminder whose time today came before it waits for tomorrow.
    // Cleared when the device moves to another account (upsertDevice).
    morningReminder: smallint('morning_reminder').$type<MinuteOfDay>(),
    eveningReminder: smallint('evening_reminder').$type<MinuteOfDay>(),
    remindersSetAt: timestamp('reminders_set_at', { withTimezone: true }),
  },
  (table) => [
    index('user_device_user_id_index').on(table.userId),
    ...REMINDER_KINDS.map((kind) => {
      const column =
        kind === 'morning' ? table.morningReminder : table.eveningReminder;
      const { from, to } = REMINDER_WINDOWS[kind];
      return check(
        `user_device_${kind}_reminder_check`,
        sql`${column} between ${sql.raw(String(from))} and ${sql.raw(String(to))} and ${column} % ${sql.raw(String(REMINDER_STEP_MINUTES))} = 0`,
      );
    }),
    check(
      'user_device_reminders_set_at_check',
      sql`(${table.morningReminder} is null and ${table.eveningReminder} is null) or ${table.remindersSetAt} is not null`,
    ),
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

// A push reminder claimed for sending (#15): one row per device, kind and
// household day, inserted by the scheduler before it sends
// (claimReminders, src/web/push/queries.ts). The primary key is what makes
// a reminder go out once: two servers overlapping during a deploy both find
// it due, both insert, and only the insert that lands (ON CONFLICT DO
// NOTHING) sends. Claims of days before yesterday are pruned nightly
// (server.ts); the device's deletion takes its rows.
export const pushReminder = pgTable(
  'push_reminder',
  {
    deviceId: integer('device_id').notNull(),
    kind: text('kind').$type<ReminderKind>().notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Leads with device_id: also the device foreign key's index.
    primaryKey({
      name: 'push_reminder_pkey',
      columns: [table.deviceId, table.kind, table.day],
    }),
    check(
      'push_reminder_kind_check',
      sql`${table.kind} in (${sqlList(REMINDER_KINDS)})`,
    ),
    foreignKey({
      name: 'push_reminder_device_id_foreign',
      columns: [table.deviceId],
      foreignColumns: [userDevice.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
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

// An outfit selfie (#19, src/web/selfies): a mirror photo as the record of
// what was worn on a day. Written only by src/web/selfies/queries.ts
// (setEntrySelfie, which marks the entry worn in the same transaction;
// deleteSelfie) and taken by deleteEntry with its entry. The owner's own,
// like the calendar: never shown to a grantee, the share page or another
// user's MCP tools, and served only to its owner (GET /selfies/*, never
// the public /file/**).
//
// A row of its own rather than a photo column on outfit_calendar, because a
// selfie outlives its entry when the outfit is deleted: like the entry's
// wears (detachOutfitWears), the photo stays the record of the day, so the
// entry reference goes null (ON DELETE SET NULL) and `day` and `owner_id`
// keep the look on the calendar. The photo's `file` row is the selfie's
// alone: reconciliation counts photo_id as a reference
// (src/web/files/references.ts), and deleting the file row takes this one.
export const selfie = pgTable(
  'selfie',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    // The entry's day ('YYYY-MM-DD'), kept when the entry goes with its outfit.
    day: date('day', { mode: 'string' }).notNull(),
    // Null once its outfit was deleted: a look kept on its own.
    outfitCalendarId: integer('outfit_calendar_id'),
    photoId: integer('photo_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One selfie per entry (a new one replaces it); detached looks, null
    // here, are distinct. Also the outfit_calendar_id foreign key's index.
    unique('selfie_outfit_calendar_id_unique').on(table.outfitCalendarId),
    // A photo is one selfie's. Also the photo_id foreign key's index.
    unique('selfie_photo_id_unique').on(table.photoId),
    // A week's looks without an entry, and the owner_id foreign key's.
    index('selfie_owner_id_day_index').on(table.ownerId, table.day),
    foreignKey({
      name: 'selfie_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'selfie_outfit_calendar_id_foreign',
      columns: [table.outfitCalendarId],
      foreignColumns: [outfitCalendar.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
    foreignKey({
      name: 'selfie_photo_id_foreign',
      columns: [table.photoId],
      foreignColumns: [file.id],
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
    uniqueIndex(CAPSULE_NAME_UNIQUE).on(
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

// A person's style profile (#34, slice 34a; src/wardrobe/style.ts): what
// they dress for and toward, one row per user, written only by
// saveStyleProfile (src/web/plans/queries.ts) with its rhythm. Private, like
// outfits: shares never reach it. The home city is the weather's
// (user_weather, #14): the style page reads it from there, never a copy here.
export const styleProfile = pgTable(
  'style_profile',
  {
    userId: integer('user_id').primaryKey(),
    // Sets, no repeats, null for none (never an empty array), like
    // garment.materials.
    styles: text('styles').array().$type<Style[]>(),
    budget: text('budget').$type<BudgetBand>(),
    palette: text('palette').array().$type<GarmentColor[]>(),
    notes: text('notes'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'style_profile_styles_check',
      sql`${table.styles} <@ array[${sqlList(STYLES)}]::text[] and cardinality(${table.styles}) > 0`,
    ),
    check(
      'style_profile_budget_check',
      sql`${table.budget} in (${sqlList(BUDGET_BANDS)})`,
    ),
    check(
      'style_profile_palette_check',
      sql`${table.palette} <@ array[${sqlList(GARMENT_COLORS)}]::text[] and cardinality(${table.palette}) > 0`,
    ),
    foreignKey({
      name: 'style_profile_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// The week's rhythm of a style profile: how often each occasion
// (src/wardrobe/occasions.ts, the calendar's words) comes round, "work 3 a
// week", "evening 3 a month". One row per occasion that has one; saved with
// its profile, replaced whole.
export const styleRhythm = pgTable(
  'style_rhythm',
  {
    userId: integer('user_id').notNull(),
    occasion: text('occasion').$type<Occasion>().notNull(),
    times: smallint('times').notNull(),
    per: text('per').$type<RhythmPeriod>().notNull(),
  },
  (table) => [
    // Also the index of the user_id foreign key.
    primaryKey({
      name: 'style_rhythm_pkey',
      columns: [table.userId, table.occasion],
    }),
    check(
      'style_rhythm_occasion_check',
      sql`${table.occasion} in (${sqlList(OCCASIONS)})`,
    ),
    check(
      'style_rhythm_times_check',
      sql`${table.times} between 1 and ${sql.raw(String(RHYTHM_TIMES_MAX))}`,
    ),
    check(
      'style_rhythm_per_check',
      sql`${table.per} in (${sqlList(RHYTHM_PERIODS)})`,
    ),
    foreignKey({
      name: 'style_rhythm_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [styleProfile.userId],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// A wardrobe plan (#34): a named ideal wardrobe its owner builds toward
// ("NYC minimal", "NYC minimal v2"), made of plan items. Private, like
// outfits: every route and tool is the signed-in owner's, shares never reach
// it. At most one is active per owner (the partial unique index; setActivePlan
// in src/web/plans/queries.ts moves it in one transaction). Names are one per
// owner whatever the case, as capsules'.
export const wardrobePlan = pgTable(
  'wardrobe_plan',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    // Trimmed, never blank; bounded by the route (PLAN_NAME_MAX).
    name: text('name').notNull(),
    notes: text('notes'),
    active: boolean('active').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Also the index of the owner_id foreign key and of every plan query.
    // owner_id as an expression, for drizzle-kit's introspection (see
    // capsule_owner_id_lower_name_unique).
    uniqueIndex(PLAN_NAME_UNIQUE).on(
      sql`${table.ownerId}`,
      sql`lower(${table.name})`,
    ),
    uniqueIndex('wardrobe_plan_owner_id_active_unique')
      .on(table.ownerId)
      .where(sql`${table.active}`),
    foreignKey({
      name: 'wardrobe_plan_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// One target of a plan, in the garment model's own terms (the value sets of
// src/wardrobe/properties.ts, checked as garment's are): "white heavyweight
// tee ×3" is tops / t-shirt, white, warmth 3 to 5, quantity 3. Every
// constraint but the category is optional (null: any). Which garments
// fulfil it is never stored: matchPlan (src/wardrobe/plans.ts) derives it on
// every read. `proposed`: written by the owner's agent (the MCP tools) and
// not yet accepted in the app, so matching leaves it out.
export const planItem = pgTable(
  'plan_item',
  {
    id: serial('id').primaryKey(),
    planId: integer('plan_id').notNull(),
    // What the owner calls it; null: the view describes it from its values.
    name: text('name'),
    // Trimmed and lower case, as garment.category.
    category: text('category').notNull(),
    type: text('type'),
    // Sets, null for none (any), never an empty array.
    colors: text('colors').array().$type<GarmentColor[]>(),
    materials: text('materials').array().$type<Material[]>(),
    // Ranges on the garment scales, both ends inclusive; both ends or neither.
    warmthMin: smallint('warmth_min').$type<Warmth>(),
    warmthMax: smallint('warmth_max').$type<Warmth>(),
    formalityMin: smallint('formality_min').$type<Formality>(),
    formalityMax: smallint('formality_max').$type<Formality>(),
    quantity: smallint('quantity').default(1).notNull(),
    priority: text('priority')
      .$type<PlanPriority>()
      .default('medium')
      .notNull(),
    // What the owner means to spend on one, in the household's currency.
    budget: numeric('budget', { precision: 10, scale: 2 }),
    // Why it is in the plan.
    note: text('note'),
    proposed: boolean('proposed').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('plan_item_plan_id_index').on(table.planId),
    check(
      'plan_item_type_check',
      sql`${table.type} in (${sqlList(ALL_GARMENT_TYPES)})`,
    ),
    check(
      'plan_item_colors_check',
      sql`${table.colors} <@ array[${sqlList(GARMENT_COLORS)}]::text[] and cardinality(${table.colors}) > 0`,
    ),
    check(
      'plan_item_materials_check',
      sql`${table.materials} <@ array[${sqlList(MATERIALS)}]::text[] and cardinality(${table.materials}) > 0`,
    ),
    check(
      'plan_item_warmth_check',
      sql`(${table.warmthMin} is null and ${table.warmthMax} is null) or (${table.warmthMin} in (${sql.raw(WARMTHS.join(', '))}) and ${table.warmthMax} in (${sql.raw(WARMTHS.join(', '))}) and ${table.warmthMin} <= ${table.warmthMax})`,
    ),
    check(
      'plan_item_formality_check',
      sql`(${table.formalityMin} is null and ${table.formalityMax} is null) or (${table.formalityMin} in (${sql.raw(FORMALITIES.join(', '))}) and ${table.formalityMax} in (${sql.raw(FORMALITIES.join(', '))}) and ${table.formalityMin} <= ${table.formalityMax})`,
    ),
    check(
      'plan_item_quantity_check',
      sql`${table.quantity} between 1 and ${sql.raw(String(QUANTITY_MAX))}`,
    ),
    check(
      'plan_item_priority_check',
      sql`${table.priority} in (${sqlList(PLAN_PRIORITIES)})`,
    ),
    check('plan_item_budget_check', sql`${table.budget} >= 0`),
    foreignKey({
      name: 'plan_item_plan_id_foreign',
      columns: [table.planId],
      foreignColumns: [wardrobePlan.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// A candidate product for a plan item (#34, slice 34b): a wishlist garment
// of the plan's owner being considered to fill it, so the shopping list can
// show what to buy for each gap. Many to many: one product can be the
// candidate of the same item in two plans (a duplicated plan keeps them),
// and an item has several. Written only by changeCandidates
// (src/web/plans/candidates.ts), which stores a pair only when the item's
// plan and the garment have the same owner and the garment is on the
// wishlist; read only through onWishlist, so once "Bought it" moves the
// garment into the closet its link stops mattering (kept, inert: matching
// is derived and never reads this table). Private like the plan: nothing a
// grantee reads joins it.
export const planItemCandidate = pgTable(
  'plan_item_candidate',
  {
    planItemId: integer('plan_item_id').notNull(),
    garmentId: integer('garment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Also the index of the plan_item_id foreign key.
    primaryKey({
      name: 'plan_item_candidate_pkey',
      columns: [table.planItemId, table.garmentId],
    }),
    index('plan_item_candidate_garment_id_index').on(table.garmentId),
    foreignKey({
      name: 'plan_item_candidate_plan_item_id_foreign',
      columns: [table.planItemId],
      foreignColumns: [planItem.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'plan_item_candidate_garment_id_foreign',
      columns: [table.garmentId],
      foreignColumns: [garment.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// Two garments the owner said clash ("Say why not", the outfit gallery #9):
// the generator never combines them again (src/wardrobe/generator.ts). The
// owner's own record, like wears: a pair of their own garments (owned now
// or once), stored once with the smaller id first. Written only by
// avoidPair and allowPair (src/web/gallery/queries.ts); deleting either
// garment or the owner deletes the row.
export const generatorAvoid = pgTable(
  'generator_avoid',
  {
    ownerId: integer('owner_id').notNull(),
    garmentAId: integer('garment_a_id').notNull(),
    garmentBId: integer('garment_b_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Leads with owner_id: the generator reads an owner's pairs, and it is
    // the owner_id foreign key's index.
    primaryKey({
      name: 'generator_avoid_pkey',
      columns: [table.ownerId, table.garmentAId, table.garmentBId],
    }),
    check(
      'generator_avoid_pair_order_check',
      sql`${table.garmentAId} < ${table.garmentBId}`,
    ),
    index('generator_avoid_garment_a_id_index').on(table.garmentAId),
    index('generator_avoid_garment_b_id_index').on(table.garmentBId),
    foreignKey({
      name: 'generator_avoid_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'generator_avoid_garment_a_id_foreign',
      columns: [table.garmentAId],
      foreignColumns: [garment.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'generator_avoid_garment_b_id_foreign',
      columns: [table.garmentBId],
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
    unique(SHARE_GRANTEE_UNIQUE).on(table.grantorId, table.granteeId),
  ],
);

// A user's weather settings (#14, src/web/weather/): where their weather is
// for and how they read it. Coordinates are stored rounded to 2 decimals
// (about 1 km; src/weather/location.ts), the only form they are ever sent
// in. `home_*` is the city picked from the geocoding search; `here_*` is the
// installed app's "use my location", used while fresh (HERE_FRESH_HOURS,
// src/web/weather/queries.ts), then home again. No row until the user sets
// something, and none at all with WEATHER_ENABLED=false (the routes that
// write it are not registered).
export const userWeather = pgTable(
  'user_weather',
  {
    userId: integer('user_id').primaryKey(),
    homeName: text('home_name'),
    homeLatitude: numeric('home_latitude', {
      precision: 4,
      scale: 2,
      mode: 'number',
    }),
    homeLongitude: numeric('home_longitude', {
      precision: 5,
      scale: 2,
      mode: 'number',
    }),
    hereLatitude: numeric('here_latitude', {
      precision: 4,
      scale: 2,
      mode: 'number',
    }),
    hereLongitude: numeric('here_longitude', {
      precision: 5,
      scale: 2,
      mode: 'number',
    }),
    hereLocatedAt: timestamp('here_located_at', { withTimezone: true }),
    // °C added to the feels-like temperature before matching, in half
    // degrees (src/weather/temperature.ts). The default is written as SQL:
    // Postgres reads a numeric default back as the literal '0', which a
    // plain 0 here would differ from in the drift check.
    temperatureOffset: numeric('temperature_offset', {
      precision: 2,
      scale: 1,
      mode: 'number',
    })
      .default(sql`'0'`)
      .notNull(),
    temperatureUnit: text('temperature_unit', { enum: TEMPERATURE_UNITS })
      .default(DEFAULT_TEMPERATURE_UNIT)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'user_weather_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'user_weather_home_check',
      sql`(${table.homeName} is null) = (${table.homeLatitude} is null) and (${table.homeLatitude} is null) = (${table.homeLongitude} is null)`,
    ),
    check(
      'user_weather_here_check',
      sql`(${table.hereLatitude} is null) = (${table.hereLongitude} is null) and (${table.hereLatitude} is null) = (${table.hereLocatedAt} is null)`,
    ),
    check(
      'user_weather_latitude_check',
      sql`${table.homeLatitude} between -90 and 90 and ${table.hereLatitude} between -90 and 90`,
    ),
    check(
      'user_weather_longitude_check',
      sql`${table.homeLongitude} between -180 and 180 and ${table.hereLongitude} between -180 and 180`,
    ),
    check(
      'user_weather_temperature_offset_check',
      sql`${table.temperatureOffset} between ${sql.raw(String(-OFFSET_LIMIT))} and ${sql.raw(String(OFFSET_LIMIT))}`,
    ),
    check(
      'user_weather_temperature_unit_check',
      sql`${table.temperatureUnit} in (${sqlList(TEMPERATURE_UNITS)})`,
    ),
  ],
);

// The forecast cache (#14, src/web/weather/service.ts): one row per rounded
// location, refreshed once it is an hour old, keeping the last good answer
// when a refresh fails. A table rather than process memory: a deploy (the
// hourly autoupdate) or a restart starts warm instead of asking Open-Meteo
// again, two servers during an overlapping deploy share it, and the last good
// answer survives a restart while Open-Meteo is down. It holds no user id:
// which user is where is user_weather's.
export const weatherForecast = pgTable(
  'weather_forecast',
  {
    latitude: numeric('latitude', {
      precision: 4,
      scale: 2,
      mode: 'number',
    }).notNull(),
    longitude: numeric('longitude', {
      precision: 5,
      scale: 2,
      mode: 'number',
    }).notNull(),
    // The last good answer, normalized (src/weather/forecast.ts); null until
    // the location's first fetch succeeds.
    forecast: jsonb('forecast').$type<Forecast>(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    // The last fetch tried, good or not: a failing provider is asked again
    // only after a pause.
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'weather_forecast_pkey',
      columns: [table.latitude, table.longitude],
    }),
    check(
      'weather_forecast_fetched_check',
      sql`(${table.forecast} is null) = (${table.fetchedAt} is null)`,
    ),
  ],
);

// Relations for db.query (relational queries); they add nothing to the
// schema. Names follow the MikroORM entities' properties.

export const userRelations = relations(user, ({ one, many }) => ({
  devices: many(userDevice),
  accessTokens: many(personalAccessToken),
  fileUploads: many(file),
  garments: many(garment),
  outfits: many(outfit),
  capsules: many(capsule),
  plans: many(wardrobePlan),
  calendarEntries: many(outfitCalendar),
  weather: one(userWeather),
  sharesGranted: many(wardrobeShare, { relationName: 'grantor' }),
  sharesReceived: many(wardrobeShare, { relationName: 'grantee' }),
}));

export const userWeatherRelations = relations(userWeather, ({ one }) => ({
  user: one(user, { fields: [userWeather.userId], references: [user.id] }),
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
  // At most one: selfie.photo_id is unique.
  selfie: one(selfie),
}));

export const selfieRelations = relations(selfie, ({ one }) => ({
  owner: one(user, { fields: [selfie.ownerId], references: [user.id] }),
  entry: one(outfitCalendar, {
    fields: [selfie.outfitCalendarId],
    references: [outfitCalendar.id],
  }),
  photo: one(file, { fields: [selfie.photoId], references: [file.id] }),
}));

export const garmentRelations = relations(garment, ({ one, many }) => ({
  photo: one(file, { fields: [garment.photoId], references: [file.id] }),
  owner: one(user, { fields: [garment.ownerId], references: [user.id] }),
  outfitSlots: many(outfitSlot),
  capsuleGarments: many(capsuleGarment),
  wears: many(garmentWear),
  planCandidacies: many(planItemCandidate),
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

export const wardrobePlanRelations = relations(
  wardrobePlan,
  ({ one, many }) => ({
    owner: one(user, { fields: [wardrobePlan.ownerId], references: [user.id] }),
    items: many(planItem),
  }),
);

export const planItemRelations = relations(planItem, ({ one, many }) => ({
  plan: one(wardrobePlan, {
    fields: [planItem.planId],
    references: [wardrobePlan.id],
  }),
  candidates: many(planItemCandidate),
}));

export const planItemCandidateRelations = relations(
  planItemCandidate,
  ({ one }) => ({
    item: one(planItem, {
      fields: [planItemCandidate.planItemId],
      references: [planItem.id],
    }),
    garment: one(garment, {
      fields: [planItemCandidate.garmentId],
      references: [garment.id],
    }),
  }),
);

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
    // At most one: selfie.outfit_calendar_id is unique.
    selfie: one(selfie),
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
