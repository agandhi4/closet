import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';
import type { PushSubscription } from 'web-push';
import type { OutfitSlot } from '../dal/entity/outfit.entity';

/**
 * The database schema, and the only source of migrations: edit it, run
 * `npx drizzle-kit generate`, review the SQL in drizzle/ (see CLAUDE.md,
 * Changing the schema). Introspected from the schema the legacy MikroORM
 * migrations built, so every constraint and index keeps the name MikroORM
 * gave it (`<table>_<column>_index`, `_unique`, `_foreign`); new ones should
 * follow the same pattern.
 *
 * The MikroORM entities in src/dal/entity/ describe the same tables for code
 * not yet ported to Drizzle. They no longer drive the schema: a change here
 * that touches a table an entity maps must be mirrored on the entity by hand.
 *
 * Columns hold what MikroORM wrote: varchar(255) strings, timestamptz dates,
 * and foreign keys that cascade on update and (except garment.photo_id) on
 * delete. Postgres does not index foreign keys on its own, so every FK column
 * has an explicit index (or leads a composite one). Calendar days are `date`
 * columns read as strings.
 */

export const user = pgTable(
  'user',
  {
    id: serial('id').primaryKey(),
    // A random UUID for share links, set by the app on insert.
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    flagged: boolean('flagged'),
    banned: boolean('banned'),
    firstName: varchar('first_name', { length: 255 }),
    lastName: varchar('last_name', { length: 255 }),
    email: varchar('email', { length: 255 }),
    // bcrypt hash.
    password: varchar('password', { length: 255 }).notNull(),
  },
  (table) => [
    index('user_shareable_id_index').on(table.shareableId),
    unique('user_email_unique').on(table.email),
  ],
);

export const userDevice = pgTable(
  'user_device',
  {
    id: serial('id').primaryKey(),
    userAgent: varchar('user_agent', { length: 255 }).notNull(),
    // Taken from the subscription as the device's identity.
    pushEndpoint: varchar('push_endpoint', { length: 255 }).notNull(),
    webPushSubscription: jsonb(
      'web_push_subscription',
    ).$type<PushSubscription>(),
    userId: integer('user_id').notNull(),
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
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    flagged: boolean('flagged'),
    banned: boolean('banned'),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimetype: varchar('mimetype', { length: 255 }),
    // An ISO timestamp as text, as MikroORM wrote it.
    createdOn: varchar('created_on', { length: 255 }).notNull(),
    createdById: integer('created_by_id').notNull(),
    // Cache-busting token of the immutable /file/** URLs, bumped whenever a
    // variant's bytes are rewritten in place.
    version: integer('version').default(1).notNull(),
  },
  (table) => [
    index('file_created_by_id_index').on(table.createdById),
    index('file_shareable_id_index').on(table.shareableId),
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
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    flagged: boolean('flagged'),
    banned: boolean('banned'),
    name: varchar('name', { length: 255 }),
    category: varchar('category', { length: 255 }).notNull(),
    brand: varchar('brand', { length: 255 }),
    size: varchar('size', { length: 255 }),
    notes: varchar('notes', { length: 255 }),
    photoId: integer('photo_id'),
    ownerId: integer('owner_id').notNull(),
    // Comma-joined GarmentColor values ("red,blue").
    color: varchar('color', { length: 255 }),
    // Misspelled in the database; the TS name keeps the column's spelling so
    // it can be found by grepping for either.
    dateAquired: timestamp('date_aquired', { withTimezone: true }),
    washingDetails: text('washing_details'),
    archived: boolean('archived').default(false).notNull(),
  },
  (table) => [
    index('garment_category_index').on(table.category),
    index('garment_owner_id_index').on(table.ownerId),
    index('garment_shareable_id_index').on(table.shareableId),
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
    shareableId: varchar('shareable_id', { length: 255 }).notNull(),
    flagged: boolean('flagged'),
    banned: boolean('banned'),
    name: varchar('name', { length: 255 }),
    notes: varchar('notes', { length: 255 }),
    ownerId: integer('owner_id').notNull(),
    slots: jsonb('slots').$type<OutfitSlot[]>(),
  },
  (table) => [
    index('outfit_owner_id_index').on(table.ownerId),
    index('outfit_shareable_id_index').on(table.shareableId),
    foreignKey({
      name: 'outfit_owner_id_foreign',
      columns: [table.ownerId],
      foreignColumns: [user.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

// The outfit <-> garment pivot. Its composite primary key leads with
// outfit_id, and each column still has its own index for the reverse lookups
// and the cascades.
export const outfitGarment = pgTable(
  'outfit_garments',
  {
    outfitId: integer('outfit_id').notNull(),
    garmentId: integer('garment_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'outfit_garments_pkey',
      columns: [table.outfitId, table.garmentId],
    }),
    index('outfit_garments_garment_id_index').on(table.garmentId),
    index('outfit_garments_outfit_id_index').on(table.outfitId),
    foreignKey({
      name: 'outfit_garments_outfit_id_foreign',
      columns: [table.outfitId],
      foreignColumns: [outfit.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'outfit_garments_garment_id_foreign',
      columns: [table.garmentId],
      foreignColumns: [garment.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
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
  outfitGarments: many(outfitGarment),
}));

export const outfitRelations = relations(outfit, ({ one, many }) => ({
  owner: one(user, { fields: [outfit.ownerId], references: [user.id] }),
  outfitGarments: many(outfitGarment),
  calendarEntries: many(outfitCalendar),
}));

export const outfitGarmentRelations = relations(outfitGarment, ({ one }) => ({
  outfit: one(outfit, {
    fields: [outfitGarment.outfitId],
    references: [outfit.id],
  }),
  garment: one(garment, {
    fields: [outfitGarment.garmentId],
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
