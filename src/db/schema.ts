import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
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
  },
  (table) => [
    index('file_created_by_id_index').on(table.createdById),
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
    archived: boolean('archived').default(false).notNull(),
  },
  (table) => [
    // The wardrobe grid's keyset pages: owner_id = ? AND archived = false
    // [AND id < cursor] ORDER BY id DESC LIMIT n, read in index order. Also
    // the index of the owner_id foreign key.
    index('garment_owner_id_archived_id_index').on(
      table.ownerId,
      table.archived,
      table.id.desc(),
    ),
    // The grid's category filter and the outfit builder's category cycles
    // (owner, category, newest first; archived is a filter on top).
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

// An outfit planned for a day. One row per (owner, day, outfit): scheduling
// is idempotent (POST /calendar and the outfit form insert ... on conflict do
// nothing).
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
  },
  (table) => [
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
  fileUploads: many(file),
  garments: many(garment),
  outfits: many(outfit),
  calendarEntries: many(outfitCalendar),
  sharesGranted: many(wardrobeShare, { relationName: 'grantor' }),
  sharesReceived: many(wardrobeShare, { relationName: 'grantee' }),
}));

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

export const outfitCalendarRelations = relations(outfitCalendar, ({ one }) => ({
  outfit: one(outfit, {
    fields: [outfitCalendar.outfitId],
    references: [outfit.id],
  }),
  owner: one(user, {
    fields: [outfitCalendar.ownerId],
    references: [user.id],
  }),
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
