import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
  uuid,
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
import type { ClimateNormals } from '../weather/normals';
import {
  DEFAULT_TEMPERATURE_UNIT,
  OFFSET_LIMIT,
  TEMPERATURE_UNITS,
} from '../weather/temperature';
import {
  DAY_OCCASIONS,
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
import {
  DEFAULT_LENGTH_UNIT,
  LENGTH_MAX_CM,
  LENGTH_MIN_CM,
  LENGTH_UNITS,
} from '../wardrobe/measurements';
import {
  ORDER_EMAIL_OUTCOMES,
  ORDER_ITEM_STATES,
  type OrderEmailOutcome,
  type OrderItemState,
} from '../wardrobe/order-items';
import { LOOK_REACTIONS, type LookReaction } from '../wardrobe/look-reaction';
import { GARMENT_STATUSES, type GarmentStatus } from '../wardrobe/status';
import {
  DISMISS_REASONS,
  OUTFIT_DISMISS_REASONS,
  type OutfitDismissReason,
  type DismissReason,
  MAX_OPTIONS_PER_GROUP,
  OPTION_GROUP_STATUSES,
  type OptionGroupStatus,
} from '../wardrobe/suggestions';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
  type CareBleach,
  type CareDry,
  type CareDryClean,
  type CareIron,
  type CareWash,
  REPAIR_KINDS,
  type RepairKind,
} from '../wardrobe/care';
import {
  type BudgetBand,
  BUDGET_BANDS,
  type Style,
  STYLES,
} from '../wardrobe/style';
import {
  DEFAULT_PLANNED_BY,
  PLANNED_BY,
  type PlannedBy,
  WEEKDAYS,
  type Weekday,
} from '../wardrobe/week';
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
export const SHARE_GRANTEE_UNIQUE =
  'wardrobe_share_grantor_id_grantee_id_unique';
export const BRAND_SIZE_UNIQUE = 'brand_size_user_id_brand_key_unique';
export type UniqueConstraint =
  | typeof USER_EMAIL_UNIQUE
  | typeof CAPSULE_NAME_UNIQUE
  | typeof SHARE_GRANTEE_UNIQUE
  | typeof BRAND_SIZE_UNIQUE;

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
    // When the owner last opened their wishlist: suggestions newer than it
    // are "new from Muse" (src/wardrobe/suggestions.ts). Never rendered into
    // a cached page; null: never opened since suggestions came.
    suggestionsSeenAt: timestamp('suggestions_seen_at', { withTimezone: true }),
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
    // Muse's rounds (#337): one notification when the agent finishes a
    // round of suggestions (finish_round). Opt-in per device like the
    // reminders, so false until turned on; off again when the device
    // moves to another account (upsertDevice).
    museRounds: boolean('muse_rounds').default(false).notNull(),
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
    // get_suggestion_feedback's "since the last call" (#337): the agent's
    // cursor over the owner's decisions, null before its first call.
    // Written only by readSuggestionFeedback (src/web/wishlist/feedback.ts).
    feedbackReadAt: timestamp('feedback_read_at', { withTimezone: true }),
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
    // only by applyCutoutEvent and its batch form applyCutoutEventToRows
    // (src/cutout/queries.ts). Pending rows are the
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
    // The running job's lease (#45): which queue worker holds it and since
    // when (the database's clock). Set by start, cleared by every event
    // that ends the job; another server claims the row only once it is
    // older than CUTOUT_LEASE_MS (src/cutout/queries.ts).
    cutoutWorker: text('cutout_worker'),
    cutoutStartedAt: timestamp('cutout_started_at', { withTimezone: true }),
    // Which nobg and thumb are the photo's (#141): a cutout written onto the
    // row stores them under a fresh key before its transaction, which then
    // points this at them with the new version (Photos.writeCutout); null
    // for the ones stored with the photo (variantFileName, image-variant.ts).
    variantKey: text('variant_key'),
  },
  (table) => [
    index('file_created_by_id_index').on(table.createdById),
    check(
      'file_cutout_status_check',
      sql`${table.cutoutStatus} in (${sqlList(CUTOUT_STATUSES)})`,
    ),
    // Both lease columns or neither, and only on a pending row: a finished
    // or failed job cannot leave a lease behind.
    check(
      'file_cutout_lease_check',
      sql`(${table.cutoutWorker} is null and ${table.cutoutStartedAt} is null) or (${table.cutoutStatus} = 'pending' and ${table.cutoutWorker} is not null and ${table.cutoutStartedAt} is not null)`,
    ),
    // The key is part of file names (newVariantKey), and only a stored
    // cutout (succeed: ready, edit: edited) sets one, so an unwanted photo
    // (an outfit selfie) is never keyed: its callers name it unkeyed.
    check(
      'file_variant_key_check',
      sql`${table.variantKey} is null or (${table.cutoutStatus} in ('ready', 'edited') and ${table.variantKey} ~ '^[0-9a-f]{12}$')`,
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

// A photo stored before its garment form is saved (bytes only, no `file`
// row: a link import's, the add sheet's upload, a draft of a multi-photo
// batch): bound to the user who stored it, who alone may claim or discard
// it. Unbatched ones are capped at MAX_PENDING_PER_USER a user (the oldest
// evicted), batched drafts at MAX_DRAFTS_PER_USER (refused past it, never
// evicted). The save deletes the row with the `file` row's insert;
// reconciliation removes day-old ones with their bytes, outside its
// deletion guard (src/web/files/pending-photos.ts, src/maintenance/reconcile.ts).
export const pendingPhoto = pgTable(
  'pending_photo',
  {
    fileName: varchar('file_name', { length: 255 }).primaryKey(),
    userId: integer('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // A draft of a multi-photo upload (#200): the upload, and the photo's
    // place in it (the queue's order: a batch's rows share created_at).
    batchId: uuid('batch_id'),
    batchPosition: smallint('batch_position'),
    // The wardrobe a draft adds to (a grantee's may be a shared one): where
    // its queue resumes. Null once that wardrobe is gone; the draft then
    // waits for reconciliation like any pending photo.
    batchOwnerId: integer('batch_owner_id'),
  },
  (table) => [
    // The per-user cap's oldest-first eviction; also the foreign key's.
    index('pending_photo_user_id_created_at_index').on(
      table.userId,
      table.createdAt,
    ),
    index('pending_photo_batch_owner_id_index').on(table.batchOwnerId),
    check(
      'pending_photo_batch_check',
      sql`(${table.batchId} is null) = (${table.batchPosition} is null)`,
    ),
    foreignKey({
      name: 'pending_photo_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'pending_photo_batch_owner_id_foreign',
      columns: [table.batchOwnerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
  ],
);

export const garment = pgTable(
  'garment',
  {
    id: serial('id').primaryKey(),
    // A random UUID for share links (/share?shareableId=), set on insert.
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    // Free text, trimmed, null when blank (src/web/wardrobe/garment-input.ts).
    name: text('name'),
    // Trimmed and lower case: the filter value and the outfit builder's key.
    category: text('category').notNull(),
    brand: text('brand'),
    size: text('size'),
    notes: text('notes'),
    photoId: integer('photo_id'),
    ownerId: integer('owner_id').notNull(),
    // A set in GARMENT_COLORS order, no repeats, null for none (never an
    // empty array), like materials. Was comma-joined
    // text (color) until drizzle/0023_garment_colors.sql.
    colors: text('colors').array().$type<GarmentColor[]>(),
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
    // src/web/wardrobe/garment-input.ts; the check is the backstop), shown as
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
    // The care label (src/wardrobe/care.ts, #23): each instruction optional,
    // a garment property like the others (the garment form, owner and
    // MANAGE), stored null for a role that has none (shoes, bags).
    careWash: text('care_wash').$type<CareWash>(),
    careBleach: text('care_bleach').$type<CareBleach>(),
    careDry: text('care_dry').$type<CareDry>(),
    careIron: text('care_iron').$type<CareIron>(),
    careDryClean: text('care_dry_clean').$type<CareDryClean>(),
    // A suggestion's provenance (Muse, #333; src/wardrobe/suggestions.ts):
    // `suggested_at` marks one (a suggestion is a garment with it set), the
    // agent's token, its option group, its note and its rank among the
    // group's options. Written only while the garment is on the wishlist
    // (by the agent's tools and drizzle/0040's migration of plan
    // candidates) and kept once it is bought, so the agent learns what came
    // of it. Never written by the garment form, never copied by a clone.
    suggestedAt: timestamp('suggested_at', { withTimezone: true }),
    suggestedByTokenId: integer('suggested_by_token_id'),
    suggestionGroupId: integer('suggestion_group_id'),
    suggestionNote: text('suggestion_note'),
    suggestionRank: smallint('suggestion_rank'),
    // Set aside, never deleted: dismissing is feedback to the agent. A
    // reason from DISMISS_REASONS (null only for a turned-down plan
    // candidate migrated with its free-text reason as the note). Written
    // only by decide (src/web/wishlist/decisions.ts).
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason').$type<DismissReason>(),
    dismissedNote: text('dismissed_note'),
    // When "Bought it" moved it off the wishlist (#337: a purchase the
    // agent hears of since its last feedback call; acquired_on is the day
    // the owner says, which may be any day). Written only by
    // setGarmentStatus's buy; null for anything bought before 0042.
    boughtAt: timestamp('bought_at', { withTimezone: true }),
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
      'garment_colors_check',
      sql`${table.colors} <@ array[${sqlList(GARMENT_COLORS)}]::text[] and cardinality(${table.colors}) > 0`,
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
      'garment_care_wash_check',
      sql`${table.careWash} in (${sqlList(CARE_WASH)})`,
    ),
    check(
      'garment_care_bleach_check',
      sql`${table.careBleach} in (${sqlList(CARE_BLEACH)})`,
    ),
    check(
      'garment_care_dry_check',
      sql`${table.careDry} in (${sqlList(CARE_DRY)})`,
    ),
    check(
      'garment_care_iron_check',
      sql`${table.careIron} in (${sqlList(CARE_IRON)})`,
    ),
    check(
      'garment_care_dry_clean_check',
      sql`${table.careDryClean} in (${sqlList(CARE_DRY_CLEAN)})`,
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
    // Provenance belongs to a suggestion: none of it without suggested_at.
    check(
      'garment_suggestion_check',
      sql`${table.suggestedAt} is not null or (${table.suggestedByTokenId} is null and ${table.suggestionGroupId} is null and ${table.suggestionNote} is null and ${table.suggestionRank} is null)`,
    ),
    check(
      'garment_suggestion_note_check',
      sql`${table.suggestionNote} is null or length(trim(${table.suggestionNote})) > 0`,
    ),
    check(
      'garment_suggestion_rank_check',
      sql`${table.suggestionRank} between 1 and ${sql.raw(String(MAX_OPTIONS_PER_GROUP))}`,
    ),
    check(
      'garment_dismissed_reason_check',
      sql`${table.dismissedReason} in (${sqlList(DISMISS_REASONS)})`,
    ),
    // A reason or a note only on a dismissal.
    check(
      'garment_dismissed_check',
      sql`${table.dismissedAt} is not null or (${table.dismissedReason} is null and ${table.dismissedNote} is null)`,
    ),
    // The wardrobe grid's keyset pages: owner_id = ? AND status = 'closet'
    // [AND id < cursor] ORDER BY id DESC LIMIT n, read in index order; the
    // wishlist page the same with 'wishlist'. Also the index of the
    // owner_id foreign key.
    // `.nullsFirst()` is what makes it `id DESC`: Drizzle's index `.desc()`
    // alone is DESC NULLS LAST, an order no `orderBy(desc(garment.id))` asks
    // for, so the planner could not read it in order (#175; see
    // src/db/CLAUDE.md). test/integration/garment-index-order.spec.ts.
    index('garment_owner_id_status_id_index').on(
      table.ownerId,
      table.status,
      table.id.desc().nullsFirst(),
    ),
    // The grid's category filter and the outfit builder's category cycles
    // (owner, category, newest first; the status is a filter on top).
    index('garment_owner_id_category_id_index').on(
      table.ownerId,
      table.category,
      table.id.desc().nullsFirst(),
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
    index('garment_suggested_by_token_id_index').on(table.suggestedByTokenId),
    foreignKey({
      name: 'garment_suggested_by_token_id_foreign',
      columns: [table.suggestedByTokenId],
      foreignColumns: [personalAccessToken.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
    // Each owner's newest suggestion (the quiet round close's minutely read,
    // quietRounds, src/web/wishlist/rounds.ts): Muse's rows only.
    index('garment_owner_id_suggested_at_index')
      .on(table.ownerId, table.suggestedAt)
      .where(sql`${table.suggestedAt} is not null`),
    // A group's picks (the decision screen, the inbox) and the foreign key's index.
    index('garment_suggestion_group_id_index').on(table.suggestionGroupId),
    foreignKey({
      name: 'garment_suggestion_group_id_foreign',
      columns: [table.suggestionGroupId],
      foreignColumns: [optionGroupId()],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
  ],
);

// garment and option_group name each other: the explicit type stops
// TypeScript inferring either table from the other.
function optionGroupId(): AnyPgColumn {
  return optionGroup.id;
}

// A round of the agent's suggestions, ended by finish_round (#337,
// src/web/wishlist/rounds.ts): what it brought is derived on every read,
// never stored: Muse's outfits proposed and options suggested in
// (`since`, `finished_at`], `since` being the owner's previous round's
// end (null for the first). Today's card is the latest round while any of
// it still waits on the owner. `summary` is the agent's one line.
export const museRound = pgTable(
  'muse_round',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    tokenId: integer('token_id'),
    since: timestamp('since', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    summary: text('summary'),
  },
  (table) => [
    // The latest round of an owner (Today, finish_round) and the owner_id
    // foreign key's index.
    index('muse_round_owner_id_finished_at_index').on(
      table.ownerId,
      table.finishedAt,
    ),
    foreignKey({
      name: 'muse_round_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('muse_round_token_id_index').on(table.tokenId),
    foreignKey({
      name: 'muse_round_token_id_foreign',
      columns: [table.tokenId],
      foreignColumns: [personalAccessToken.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
    check(
      'muse_round_summary_check',
      sql`${table.summary} is null or length(trim(${table.summary})) > 0`,
    ),
  ],
);

// One need the owner's agent researched ("a navy blazer, under $300", Muse,
// #333; src/wardrobe/suggestions.ts): its budget and reasoning, and the
// owner's decision. Its options are the wishlist garments whose
// suggestion_group_id names it, ranked by the agent; it may hold none yet
// ("still looking"). `resolved_garment_id`: the garment that settled it,
// one of its picks (chosen, or bought) or "a different one" the owner
// bought instead; deleting it leaves the group resolved. `decided_at` is
// when it left open, the stamp a choice's set-aside siblings share, so an
// undo restores exactly them. Never deleted but with its owner. Written
// only by decide (src/web/wishlist/decisions.ts) after its insert.
export const optionGroup = pgTable(
  'option_group',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    // The need, trimmed, never blank.
    name: text('name').notNull(),
    // What one should cost at most, in the household's currency.
    budget: numeric('budget', { precision: 10, scale: 2 }),
    // The agent's reasoning.
    note: text('note'),
    suggestedByTokenId: integer('suggested_by_token_id'),
    status: text('status').$type<OptionGroupStatus>().default('open').notNull(),
    resolvedGarmentId: integer('resolved_garment_id'),
    dismissedReason: text('dismissed_reason').$type<DismissReason>(),
    // The owner's word to the agent: with "Not for me" on the need, or
    // carried from a plan item's review.
    ownerNote: text('owner_note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'option_group_status_check',
      sql`${table.status} in (${sqlList(OPTION_GROUP_STATUSES)})`,
    ),
    check('option_group_name_check', sql`length(trim(${table.name})) > 0`),
    check('option_group_budget_check', sql`${table.budget} >= 0`),
    // Open is exactly undecided.
    check(
      'option_group_decided_at_check',
      sql`(${table.status} = 'open') = (${table.decidedAt} is null)`,
    ),
    check(
      'option_group_dismissed_reason_check',
      sql`${table.dismissedReason} is null or (${table.status} = 'dismissed' and ${table.dismissedReason} in (${sqlList(DISMISS_REASONS)}))`,
    ),
    // Open and dismissed groups name no garment that settled them.
    check(
      'option_group_resolved_garment_id_check',
      sql`${table.status} = 'resolved' or ${table.resolvedGarmentId} is null`,
    ),
    // The inbox's read (owner, open first) and the owner_id foreign key's index.
    index('option_group_owner_id_status_index').on(table.ownerId, table.status),
    foreignKey({
      name: 'option_group_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('option_group_suggested_by_token_id_index').on(
      table.suggestedByTokenId,
    ),
    foreignKey({
      name: 'option_group_suggested_by_token_id_foreign',
      columns: [table.suggestedByTokenId],
      foreignColumns: [personalAccessToken.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
    index('option_group_resolved_garment_id_index').on(table.resolvedGarmentId),
    foreignKey({
      name: 'option_group_resolved_garment_id_foreign',
      columns: [table.resolvedGarmentId],
      foreignColumns: [garment.id],
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
    // A Muse outfit (#335, docs/plans/2026-10-05-muse-suggestions.md): one
    // the owner's agent proposed, marked by `proposed_at` (the token is
    // revoked, never deleted, but the mark should not hang on a nullable
    // key), with the agent's note and the owner's reaction
    // (src/wardrobe/look-reaction.ts: proposed, loved, revise, declined;
    // with a reason when declined, OUTFIT_DISMISS_REASONS). Written only by
    // src/web/outfits/proposals.ts and the migration that made plan looks
    // outfits (0041). An owner's own outfit has none of these.
    proposedAt: timestamp('proposed_at', { withTimezone: true }),
    proposedByTokenId: integer('proposed_by_token_id'),
    proposalNote: text('proposal_note'),
    reaction: text('reaction').$type<LookReaction>(),
    ownerNote: text('owner_note'),
    dismissedReason: text('dismissed_reason').$type<OutfitDismissReason>(),
    reactedAt: timestamp('reacted_at', { withTimezone: true }),
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
    // Each owner's newest proposal (quietRounds, as garment's).
    index('outfit_owner_id_proposed_at_index')
      .on(table.ownerId, table.proposedAt)
      .where(sql`${table.proposedAt} is not null`),
    index('outfit_proposed_by_token_id_index').on(table.proposedByTokenId),
    foreignKey({
      name: 'outfit_proposed_by_token_id_foreign',
      columns: [table.proposedByTokenId],
      foreignColumns: [personalAccessToken.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
    // A reaction, and only a reaction, on a proposal.
    check(
      'outfit_proposal_check',
      sql`(${table.proposedAt} is null) = (${table.reaction} is null) and (${table.proposedAt} is not null or (${table.proposedByTokenId} is null and ${table.proposalNote} is null and ${table.ownerNote} is null and ${table.reactedAt} is null))`,
    ),
    check(
      'outfit_reaction_check',
      sql`${table.reaction} in (${sqlList(LOOK_REACTIONS)})`,
    ),
    check(
      'outfit_proposal_note_check',
      sql`${table.proposalNote} is null or length(trim(${table.proposalNote})) > 0`,
    ),
    // "Change this" is the owner's note: the agent has nothing to go on without it.
    check(
      'outfit_owner_note_check',
      sql`${table.reaction} is distinct from 'revise' or ${table.ownerNote} is not null`,
    ),
    check(
      'outfit_dismissed_reason_check',
      sql`${table.dismissedReason} is null or (${table.reaction} = 'declined' and ${table.dismissedReason} in (${sqlList(OUTFIT_DISMISS_REASONS)}))`,
    ),
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
    // (src/calendar-date.ts). Was `date timestamptz` at UTC
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
    // Who owns the choice (#16, src/wardrobe/week.ts): 'auto' while the
    // week planner's pick stands untouched, so its daily re-plan may swap
    // it; 'user' for everything a person planned, and for an auto entry
    // once they edit its outfit or mark it worn. Every entry before #16 is
    // the user's.
    plannedBy: text('planned_by')
      .$type<PlannedBy>()
      .default(DEFAULT_PLANNED_BY)
      .notNull(),
  },
  (table) => [
    check(
      'outfit_calendar_occasion_check',
      sql`${table.occasion} in (${sqlList(OCCASIONS)})`,
    ),
    check(
      'outfit_calendar_planned_by_check',
      sql`${table.plannedBy} in (${sqlList(PLANNED_BY)})`,
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

/**
 * A garment's repair and alteration log (#23): what was done to it, on which
 * day, and what it cost. The owner's own record, like wears: only the owner
 * reads or writes it (src/web/wardrobe/repairs.ts, under the owner lock),
 * and deleting the garment takes it. The cost is kept beside the price, not
 * added to it: cost per wear stays the price's (docs/plans, section 17).
 */
export const garmentRepair = pgTable(
  'garment_repair',
  {
    id: serial('id').primaryKey(),
    garmentId: integer('garment_id').notNull(),
    // The day it was done ('YYYY-MM-DD', APP_TIMEZONE's date), never after
    // the day it was logged.
    day: date('day', { mode: 'string' }).notNull(),
    kind: text('kind').$type<RepairKind>().notNull(),
    // What was done: a line, trimmed, never blank.
    note: text('note').notNull(),
    // What it cost, in the household's currency; a string like price.
    cost: numeric('cost', { precision: 10, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'garment_repair_kind_check',
      sql`${table.kind} in (${sqlList(REPAIR_KINDS)})`,
    ),
    check('garment_repair_cost_check', sql`${table.cost} >= 0`),
    check('garment_repair_note_check', sql`length(trim(${table.note})) > 0`),
    // The log, newest first. Also the index of the garment_id foreign key.
    index('garment_repair_garment_id_day_index').on(table.garmentId, table.day),
    foreignKey({
      name: 'garment_repair_garment_id_foreign',
      columns: [table.garmentId],
      foreignColumns: [garment.id],
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
// saveStyleProfile (src/web/plans/queries.ts). Its rhythm is derived from
// the week template (week_template, #16), never stored here. Private, like
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

// Body measurements (#24; src/wardrobe/measurements.ts, src/web/sizes/):
// one row per user once they save any, every length in cm (two decimals)
// and the unit they read and type them in, the weather's temperature
// pattern. Private, like the style profile: no route takes another user's.
// Written only by saveMeasurements and setLengthUnit (src/web/sizes/queries.ts).
const lengthCm = (name: string) =>
  numeric(name, { precision: 5, scale: 2, mode: 'number' });

export const bodyMeasurements = pgTable(
  'body_measurements',
  {
    userId: integer('user_id').primaryKey(),
    unit: text('unit', { enum: LENGTH_UNITS })
      .default(DEFAULT_LENGTH_UNIT)
      .notNull(),
    heightCm: lengthCm('height_cm'),
    neckCm: lengthCm('neck_cm'),
    shouldersCm: lengthCm('shoulders_cm'),
    chestCm: lengthCm('chest_cm'),
    sleeveCm: lengthCm('sleeve_cm'),
    waistCm: lengthCm('waist_cm'),
    hipsCm: lengthCm('hips_cm'),
    inseamCm: lengthCm('inseam_cm'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'body_measurements_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'body_measurements_unit_check',
      sql`${table.unit} in (${sqlList(LENGTH_UNITS)})`,
    ),
    // A null length passes (between is unknown), a set one is a body's.
    check(
      'body_measurements_length_check',
      sql.join(
        [
          table.heightCm,
          table.neckCm,
          table.shouldersCm,
          table.chestCm,
          table.sleeveCm,
          table.waistCm,
          table.hipsCm,
          table.inseamCm,
        ].map(
          (column) =>
            sql`${column} between ${sql.raw(String(LENGTH_MIN_CM))} and ${sql.raw(String(LENGTH_MAX_CM))}`,
        ),
        sql` and `,
      ),
    ),
  ],
);

// Per-brand sizes (#24; src/web/sizes/): the size a user wears in a brand
// and a note on how it runs ("runs small, size up"), shown wherever that
// brand is on the user's own screen (the garment form, the wishlist). One
// row per brand whatever the case: brand is the spelling shown (brandSpelling,
// src/wardrobe/brands.ts) and brand_key its brandKey, the one rule every brand
// comparison uses, computed in JS (never SQL's lower(), which is the
// collation's and disagrees on non-ASCII). Private, like the style profile.
// Written only by the writers in src/web/sizes/queries.ts.
export const brandSize = pgTable(
  'brand_size',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull(),
    brand: text('brand').notNull(),
    brandKey: text('brand_key').notNull(),
    size: text('size'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Also the index of the user_id foreign key and of every read (user
    // first).
    uniqueIndex(BRAND_SIZE_UNIQUE).on(table.userId, table.brandKey),
    foreignKey({
      name: 'brand_size_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'brand_size_size_or_note_check',
      sql`${table.size} is not null or ${table.note} is not null`,
    ),
  ],
);

// The week template (#16; src/wardrobe/week.ts): the occasions each
// weekday holds, the one model of how a person's week is shaped ("Plan my
// week" fills it; the style profile's rhythm is derived from it). One row
// per (weekday, occasion); written only by saveWeekTemplate
// (src/web/week-plan/template.ts), replaced whole. A weekday holds at most
// one of DAY_OCCASIONS (the outfit worn through the day): the partial
// unique index. Replaced #34a's style_rhythm (occasion counts), whose weekly
// rows drizzle/0022_week_plan.sql spread onto weekdays. Private, like the
// style profile.
export const weekTemplate = pgTable(
  'week_template',
  {
    userId: integer('user_id').notNull(),
    // 0 = Sunday ... 6 = Saturday (calendar-date.ts's dayOfWeek).
    weekday: smallint('weekday').$type<Weekday>().notNull(),
    occasion: text('occasion').$type<Occasion>().notNull(),
  },
  (table) => [
    // Also the index of the user_id foreign key.
    primaryKey({
      name: 'week_template_pkey',
      columns: [table.userId, table.weekday, table.occasion],
    }),
    uniqueIndex('week_template_user_id_weekday_day_unique')
      .on(table.userId, table.weekday)
      .where(sql`${table.occasion} in (${sqlList(DAY_OCCASIONS)})`),
    check(
      'week_template_weekday_check',
      sql`${table.weekday} between ${sql.raw(String(WEEKDAYS[0]))} and ${sql.raw(String(WEEKDAYS[WEEKDAYS.length - 1]))}`,
    ),
    check(
      'week_template_occasion_check',
      sql`${table.occasion} in (${sqlList(OCCASIONS)})`,
    ),
    foreignKey({
      name: 'week_template_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// One "Plan my week" (#16): the batch of entries the planner wrote in one
// tap, what the calendar shows as just planned and what Undo removes
// (src/web/week-plan/plan.ts). Private, like the calendar.
export const weekPlan = pgTable(
  'week_plan',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('week_plan_owner_id_index').on(table.ownerId),
    foreignKey({
      name: 'week_plan_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// A calendar entry the week planner wrote: its batch, whether the planner
// created its outfit (so Undo and a swap can take an outfit nobody else
// uses away with it), and the targets it was planned for
// (src/wardrobe/week-planner.ts PlannedNeeds; all null when it was planned
// without a forecast), which the daily re-plan compares with the newer
// forecast. Kept when the entry becomes the user's: planned_by says who owns
// the choice now, this row where it came from.
export const weekPlanEntry = pgTable(
  'week_plan_entry',
  {
    entryId: integer('entry_id').primaryKey(),
    weekPlanId: integer('week_plan_id').notNull(),
    outfitCreated: boolean('outfit_created').notNull(),
    torso: smallint('torso'),
    limbs: smallint('limbs'),
    layer: boolean('layer'),
    rain: boolean('rain'),
  },
  (table) => [
    index('week_plan_entry_week_plan_id_index').on(table.weekPlanId),
    check(
      'week_plan_entry_needs_check',
      sql`num_nulls(${table.torso}, ${table.limbs}, ${table.layer}, ${table.rain}) in (0, 4)`,
    ),
    foreignKey({
      name: 'week_plan_entry_entry_id_foreign',
      columns: [table.entryId],
      foreignColumns: [outfitCalendar.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'week_plan_entry_week_plan_id_foreign',
      columns: [table.weekPlanId],
      foreignColumns: [weekPlan.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// The daily re-plan's claim (#16): one row per (user, household day),
// inserted before that user's auto entries are judged
// (src/web/week-plan/replan.ts). The primary key is what runs a user's
// re-plan once a day: two servers overlapping in a deploy, or every minute
// after the hour on one, both try and only the insert that lands (ON
// CONFLICT DO NOTHING) re-plans and pushes. Past days are pruned nightly.
export const weekReplan = pgTable(
  'week_replan',
  {
    userId: integer('user_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Leads with user_id: also the user foreign key's index.
    primaryKey({
      name: 'week_replan_pkey',
      columns: [table.userId, table.day],
    }),
    foreignKey({
      name: 'week_replan_user_id_foreign',
      columns: [table.userId],
      foreignColumns: [user.id],
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

// A trip (#10; docs/plans/2026-09-26-wardrobe-features.md, section 4): a
// standalone list of outfits for some days away and the packing list derived
// from them (owner decision: not a date range over the calendar). Private,
// like outfits: every route and tool is the signed-in owner's, shares never
// reach it. Written only by src/web/trips/queries.ts. The destination is a
// name the owner types and, once picked from the weather's geocoding search
// (#14), its location rounded to 2 decimals like every stored coordinate
// (src/weather/location.ts), which gives the trip its forecast. A new name
// clears the location it no longer describes.
export const trip = pgTable(
  'trip',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    // Trimmed, never blank; bounded by the route (TRIP_NAME_MAX).
    name: text('name').notNull(),
    destination: text('destination'),
    latitude: numeric('latitude', { precision: 4, scale: 2, mode: 'number' }),
    longitude: numeric('longitude', {
      precision: 5,
      scale: 2,
      mode: 'number',
    }),
    // The first and last day away, both included ('YYYY-MM-DD').
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The list (upcoming first) and the owner_id foreign key's index.
    index('trip_owner_id_starts_on_index').on(table.ownerId, table.startsOn),
    check('trip_dates_check', sql`${table.endsOn} >= ${table.startsOn}`),
    check(
      'trip_location_check',
      sql`(${table.latitude} is null) = (${table.longitude} is null) and (${table.latitude} is null or ${table.destination} is not null)`,
    ),
    check(
      'trip_coordinates_check',
      sql`${table.latitude} between -90 and 90 and ${table.longitude} between -180 and 180`,
    ),
    foreignKey({
      name: 'trip_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// An outfit of the owner's on a trip, optionally for one of its days and an
// occasion ("Day 2, dinner"; plan section 8). The same outfit is on a trip
// once per day (the two partial unique indexes: once with a day, once
// without), so adding it again is idempotent (on conflict do nothing).
// `day` is always one of the trip's days: addTripOutfit refuses any other,
// and updateTrip clears the days its new dates leave out, in the same
// transaction. Deleting the outfit or the trip deletes the row.
export const tripOutfit = pgTable(
  'trip_outfit',
  {
    id: serial('id').primaryKey(),
    tripId: integer('trip_id').notNull(),
    outfitId: integer('outfit_id').notNull(),
    day: date('day', { mode: 'string' }),
    // src/wardrobe/occasions.ts OCCASIONS; null: not said.
    occasion: text('occasion').$type<Occasion>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Also the index of the trip_id foreign key (both lead with it).
    uniqueIndex('trip_outfit_trip_id_outfit_id_day_unique')
      .on(table.tripId, table.outfitId, table.day)
      .where(sql`${table.day} is not null`),
    uniqueIndex('trip_outfit_trip_id_outfit_id_undated_unique')
      .on(table.tripId, table.outfitId)
      .where(sql`${table.day} is null`),
    index('trip_outfit_outfit_id_index').on(table.outfitId),
    check(
      'trip_outfit_occasion_check',
      sql`${table.occasion} in (${sqlList(OCCASIONS)})`,
    ),
    foreignKey({
      name: 'trip_outfit_trip_id_foreign',
      columns: [table.tripId],
      foreignColumns: [trip.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'trip_outfit_outfit_id_foreign',
      columns: [table.outfitId],
      foreignColumns: [outfit.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// A trip's extras: what goes in the bag that is not a garment (a charger,
// toiletries, the passport), each packed or not. A label is on a trip once
// whatever its case, so adding one again, or copying extras from a previous
// trip twice, adds nothing (on conflict do nothing). In the order added.
export const tripItem = pgTable(
  'trip_item',
  {
    id: serial('id').primaryKey(),
    tripId: integer('trip_id').notNull(),
    // Trimmed, never blank; bounded by the route (TRIP_ITEM_MAX).
    label: text('label').notNull(),
    packed: boolean('packed').default(false).notNull(),
  },
  (table) => [
    // Also the index of the trip_id foreign key. trip_id as an expression,
    // for drizzle-kit's introspection (see capsule_owner_id_lower_name_unique).
    uniqueIndex('trip_item_trip_id_lower_label_unique').on(
      sql`${table.tripId}`,
      sql`lower(${table.label})`,
    ),
    foreignKey({
      name: 'trip_item_trip_id_foreign',
      columns: [table.tripId],
      foreignColumns: [trip.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// A garment marked packed for a trip: a row means packed. Keyed by garment,
// not by trip outfit, so the mark survives any edit that keeps the garment
// on the trip's packing list (src/wardrobe/packing.ts, derived on every
// read). A mark whose garment left the list (its outfit was removed from the
// trip, edited, or deleted) is ignored by the reads and deleted by the
// writer that removed it (prunePacked, src/web/trips/queries.ts), so the
// garment comes back unpacked. Deleting the garment or the trip deletes it.
export const tripGarmentPacked = pgTable(
  'trip_garment_packed',
  {
    tripId: integer('trip_id').notNull(),
    garmentId: integer('garment_id').notNull(),
  },
  (table) => [
    // Also the index of the trip_id foreign key.
    primaryKey({
      name: 'trip_garment_packed_pkey',
      columns: [table.tripId, table.garmentId],
    }),
    index('trip_garment_packed_garment_id_index').on(table.garmentId),
    foreignKey({
      name: 'trip_garment_packed_trip_id_foreign',
      columns: [table.tripId],
      foreignColumns: [trip.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'trip_garment_packed_garment_id_foreign',
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
    // Also the grantor_id foreign key's index and the grantor's lookups: a
    // separate grantor_id index duplicated its leading column (dropped in
    // 0031, #175).
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

// The climate normals cache (#14's "typical" days, for #10's trips;
// src/web/weather/service.ts): one row per rounded location holding every
// calendar day's normals (src/weather/normals.ts), refreshed once it is 30
// days old, keeping the last good answer. Beside weather_forecast rather than
// a kind in it: a different answer (a year of normals from ten years of the
// archive, not 16 days ahead), a different lifetime and a different
// endpoint, so a shared row would need a kind in its key and a payload typed
// by that kind. One row per location, not per month: the archive answers a
// date range, so any month's normals take the ten years' fetch anyway, and
// once fetched every day of the year comes with it.
export const weatherNormals = pgTable(
  'weather_normals',
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
    // The last good answer; null until the location's first fetch succeeds.
    normals: jsonb('normals').$type<ClimateNormals>(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'weather_normals_pkey',
      columns: [table.latitude, table.longitude],
    }),
    check(
      'weather_normals_fetched_check',
      sql`(${table.normals} is null) = (${table.fetchedAt} is null)`,
    ),
  ],
);

// One row per email the order mail read (#25, src/web/wardrobe/order-mail/):
// the processed ids, so closet never marks, moves or deletes mail (its
// token is read-only). Written with that email's items in one transaction,
// after its links were fetched (recordOrderEmail); an email a run did not
// finish has no row and is read again. The newest received_at is the next
// poll's watermark.
export const orderEmail = pgTable(
  'order_email',
  {
    id: serial('id').primaryKey(),
    // JMAP ids are unique within their account only.
    accountId: text('account_id').notNull(),
    emailId: text('email_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    outcome: text('outcome').$type<OrderEmailOutcome>().notNull(),
    // How many products it added to the review list.
    items: smallint('items').notNull().default(0),
  },
  (table) => [
    unique('order_email_account_id_email_id_unique').on(
      table.accountId,
      table.emailId,
    ),
    // The watermark: max(received_at).
    index('order_email_received_at_index').on(table.receivedAt),
    check(
      'order_email_outcome_check',
      sql`${table.outcome} in (${sqlList(ORDER_EMAIL_OUTCOMES)})`,
    ),
  ],
);

// "From your orders" (#25): a product found in a forwarded order email,
// waiting for its owner to add it to the closet (through the link import's
// garment form) or dismiss it. Never a garment until then, and never on the
// wishlist, which grantees read. `state` moves once, pending to added (the
// garment saved with it, in its transaction: markOrderItemAdded) or to
// dismissed (dismissOrderItem); decided_at is set exactly then.
export const orderItem = pgTable(
  'order_item',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    orderEmailId: integer('order_email_id').notNull(),
    // The product page's address after redirects, tracking parameters
    // stripped (order-mail/links.ts).
    productUrl: text('product_url').notNull(),
    name: text('name'),
    brand: text('brand'),
    price: numeric('price', { precision: 10, scale: 2 }),
    // ISO 4217 when the page said.
    currency: varchar('currency', { length: 3 }),
    // The day the email arrived, in APP_TIMEZONE: the acquired date the
    // garment form is prefilled with.
    orderedOn: date('ordered_on', { mode: 'string' }).notNull(),
    state: text('state').$type<OrderItemState>().notNull().default('pending'),
    garmentId: integer('garment_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    // A product listed once per owner: its confirmation and shipping
    // emails both name it. Also the index of the owner_id foreign key.
    unique('order_item_owner_id_product_url_unique').on(
      table.ownerId,
      table.productUrl,
    ),
    index('order_item_order_email_id_index').on(table.orderEmailId),
    index('order_item_garment_id_index').on(table.garmentId),
    check(
      'order_item_state_check',
      sql`${table.state} in (${sqlList(ORDER_ITEM_STATES)})`,
    ),
    check(
      'order_item_decided_check',
      sql`(${table.state} = 'pending') = (${table.decidedAt} is null)`,
    ),
    check(
      'order_item_product_url_check',
      sql`${table.productUrl} ~* '^https?://'`,
    ),
    check('order_item_price_check', sql`${table.price} >= 0`),
    foreignKey({
      name: 'order_item_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'order_item_order_email_id_foreign',
      columns: [table.orderEmailId],
      foreignColumns: [orderEmail.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'order_item_garment_id_foreign',
      columns: [table.garmentId],
      foreignColumns: [garment.id],
    })
      .onUpdate('cascade')
      .onDelete('set null'),
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
  trips: many(trip),
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
  repairs: many(garmentRepair),
}));

export const garmentRepairRelations = relations(garmentRepair, ({ one }) => ({
  garment: one(garment, {
    fields: [garmentRepair.garmentId],
    references: [garment.id],
  }),
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
  trips: many(tripOutfit),
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

export const tripRelations = relations(trip, ({ one, many }) => ({
  owner: one(user, { fields: [trip.ownerId], references: [user.id] }),
  outfits: many(tripOutfit),
  items: many(tripItem),
}));

export const tripOutfitRelations = relations(tripOutfit, ({ one }) => ({
  trip: one(trip, { fields: [tripOutfit.tripId], references: [trip.id] }),
  outfit: one(outfit, {
    fields: [tripOutfit.outfitId],
    references: [outfit.id],
  }),
}));

export const tripItemRelations = relations(tripItem, ({ one }) => ({
  trip: one(trip, { fields: [tripItem.tripId], references: [trip.id] }),
}));

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
