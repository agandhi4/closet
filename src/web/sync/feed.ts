import type { Static, TSchema } from '@sinclair/typebox';
import type { Db, Queryable } from '../../db/client';
import { SYNC_ROOTS, type SyncResource } from '../../db/sync-tables';
import { capsulesByIds } from '../capsules/queries';
import { SyncedCapsule, toSyncedCapsule } from '../capsules/capsule-resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { Actor } from '../sharing/access';
import { SyncedGarment, toSyncedGarment } from '../wardrobe/garment-resource';
import { garmentsByIds } from '../wardrobe/queries';
import { wearsByIds } from '../wears/queries';
import { SyncedWear, toSyncedWear } from '../wears/wear-resource';
import {
  type ChangesCursor,
  endOf,
  isExpired,
  KIND,
  type Position,
  readChangesCursor,
  startOf,
  writeChangesCursor,
} from './cursor';
import {
  type FeedItem,
  type FeedRoot,
  feedItems,
  feedWardrobes,
  inFeedSnapshot,
  type WardrobeRead,
} from './queries';

/**
 * The changes feed (#196b-1, GET /api/v1/changes; src/web/sync/AGENTS.md):
 * every synced row and deletion after a cursor, across the caller's own
 * wardrobe and each one shared with them, a page at a time.
 */

/** A resource's part of the feed: its name, who may read it, and its batched reader. */
export interface FeedEntry {
  /** The API's name for it: a change's `resource`. */
  name: string;
  /** Carried in a grantee's feed too (src/web/sharing/AGENTS.md's share-aware list). */
  shared: boolean;
  /** Its `data`'s schema (titled: the spec's component). */
  schema: TSchema;
  /**
   * The rows with these ids as `data`, in one statement whatever their
   * owners: the page's ids come from wardrobes `viewerId` may see, read in
   * the same snapshot, so every id is there. A share's rows in the grantee
   * shape (the viewer is not their owner).
   */
  read(
    db: Queryable,
    ids: readonly number[],
    viewerId: number,
  ): Promise<{ id: number; data: unknown }[]>;
}

/** An entry whose reader answers its schema's shape. */
function feedEntry<S extends TSchema>(entry: {
  name: string;
  shared: boolean;
  schema: S;
  read(
    db: Queryable,
    ids: readonly number[],
    viewerId: number,
  ): Promise<{ id: number; data: Static<S> }[]>;
}): FeedEntry {
  return entry;
}

/**
 * The synced roots the feed does not carry yet: #608 registers each in
 * FEED and empties this list (feed.spec.ts holds the two to SYNC_ROOTS).
 */
export const PENDING_FEED_RESOURCES = [
  'outfit',
  'outfit_calendar',
  'selfie',
  'trip',
  'week_plan',
  'brand_size',
  'style_profile',
  'body_measurements',
] as const satisfies readonly SyncResource[];

type FeedResource = Exclude<
  SyncResource,
  (typeof PENDING_FEED_RESOURCES)[number]
>;

/**
 * Every resource the feed carries, by its table (src/db/sync-tables.ts): a
 * new synced root fails tsc here until it is registered or listed pending.
 * Adding one is an entry: its batched by-id reader beside its per-id one,
 * and its feed shape beside its API resource.
 */
export const FEED: Readonly<Record<FeedResource, FeedEntry>> = {
  garment: feedEntry({
    name: 'garment',
    shared: true,
    schema: SyncedGarment,
    read: async (db, ids, viewerId) =>
      (await garmentsByIds(db, viewerId, ids)).map((row) => ({
        id: row.id,
        data: toSyncedGarment(row),
      })),
  }),
  garment_wear: feedEntry({
    name: 'wear',
    shared: false,
    schema: SyncedWear,
    read: async (db, ids) =>
      (await wearsByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedWear(row),
      })),
  }),
  capsule: feedEntry({
    name: 'capsule',
    shared: true,
    schema: SyncedCapsule,
    read: async (db, ids) =>
      (await capsulesByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedCapsule(row),
      })),
  }),
};

function isFeedResource(table: SyncResource): table is FeedResource {
  return table in FEED;
}

const OWN_ROOTS: readonly FeedRoot[] = SYNC_ROOTS.filter((root) =>
  isFeedResource(root.table),
);
const SHARED_ROOTS = OWN_ROOTS.filter(
  (root) => isFeedResource(root.table) && FEED[root.table].shared,
);

/**
 * Which resources a cursor was answered with, one bit per SYNC_ROOTS entry
 * registered: a cursor from before a resource joined the feed never saw
 * that resource's rows below its positions, so it is expired (a full sync)
 * rather than silently missing them.
 */
export const FEED_COVERAGE = SYNC_ROOTS.reduce(
  (bits, root, index) =>
    isFeedResource(root.table) ? bits | (1 << index) : bits,
  0,
);

interface Item {
  resource: string;
  ownerId: number;
  id: number;
  clientId?: string;
  revision: number;
}

export interface ChangesPage {
  changes: (Item & { data: unknown })[];
  deletions: Item[];
  cursor: string;
  more: boolean;
  /** Owners in the cursor the caller no longer sees: a share revoked or left. */
  revokedWardrobes: number[];
}

/** The 410 `cursor_expired`: a deletion the cursor needs may have been pruned. */
function expired(logDetail: string): HttpError {
  return new HttpError(410, t('api.CURSOR_EXPIRED'), {
    code: 'cursor_expired',
    logDetail,
  });
}

/**
 * The page after `cursorText` (none: everything), at most `limit` items.
 * One REPEATABLE READ READ ONLY transaction: the wardrobes, the keyset
 * read, then one statement per resource on the page, so its cost does not
 * grow with `limit`.
 */
export async function readChanges(
  db: Db,
  actor: Actor,
  cursorText: string | undefined,
  limit: number,
): Promise<ChangesPage> {
  const cursor =
    cursorText === undefined ? undefined : readChangesCursor(cursorText);
  if (cursor && cursor.coverage !== FEED_COVERAGE) {
    throw expired(
      `a cursor of coverage ${cursor.coverage}, not ${FEED_COVERAGE}`,
    );
  }
  return inFeedSnapshot(db, async (tx) => {
    const wardrobes = await feedWardrobes(tx, actor.userId);
    const reads = wardrobes.map((wardrobe): WardrobeRead => {
      const at =
        cursor?.positions.get(wardrobe.ownerId) ?? startOf(wardrobe.floor);
      if (isExpired(at, wardrobe.floor)) {
        throw expired(
          `owner ${wardrobe.ownerId} at revision ${at.revision}, floor ${wardrobe.floor}`,
        );
      }
      return {
        ...wardrobe,
        at,
        roots: wardrobe.ownerId === actor.userId ? OWN_ROOTS : SHARED_ROOTS,
      };
    });
    const items = await feedItems(tx, reads, limit + 1);
    const page = items.slice(0, limit);
    const data = await hydrate(tx, actor.userId, page);
    const seen = new Set(wardrobes.map((wardrobe) => wardrobe.ownerId));
    return {
      changes: page
        .filter((item) => item.kind === KIND.row)
        .map((item) => ({ ...itemOf(item), data: dataOf(data, item) })),
      deletions: page
        .filter((item) => item.kind === KIND.tombstone)
        .map(itemOf),
      cursor: writeChangesCursor(nextCursor(reads, page.at(-1), items[limit])),
      more: items.length > limit,
      revokedWardrobes: cursor
        ? [...cursor.positions.keys()].filter((ownerId) => !seen.has(ownerId))
        : [],
    };
  });
}

function itemOf(item: FeedItem): Item {
  return {
    resource: entryOf(item.resource).name,
    ownerId: item.ownerId,
    id: item.id,
    ...(item.clientId !== null && { clientId: item.clientId }),
    revision: item.revision,
  };
}

function entryOf(resource: SyncResource): FeedEntry {
  if (!isFeedResource(resource)) {
    throw new Error(`The feed read ${resource}, which it does not carry`);
  }
  return FEED[resource];
}

/** Each resource's rows on the page, by id: one statement per resource. */
async function hydrate(
  db: Queryable,
  viewerId: number,
  page: readonly FeedItem[],
): Promise<Map<SyncResource, Map<number, unknown>>> {
  const idsOf = new Map<SyncResource, number[]>();
  for (const item of page) {
    if (item.kind !== KIND.row) continue;
    idsOf.set(item.resource, [...(idsOf.get(item.resource) ?? []), item.id]);
  }
  const data = new Map<SyncResource, Map<number, unknown>>();
  for (const [resource, ids] of idsOf) {
    const rows = await entryOf(resource).read(db, ids, viewerId);
    data.set(resource, new Map(rows.map((row) => [row.id, row.data])));
  }
  return data;
}

function dataOf(
  data: Map<SyncResource, Map<number, unknown>>,
  item: FeedItem,
): unknown {
  const row = data.get(item.resource)?.get(item.id);
  if (row === undefined) {
    throw new Error(`${item.resource} ${item.id} was on the page but not read`);
  }
  return row;
}

/**
 * Each wardrobe's position after this page. `next` is the first item past
 * the page (absent: nothing is left anywhere). A wardrobe before next's has
 * been read to its end; next's own resumes after its last item on the page,
 * or where it was if it had none; one after next's is untouched.
 */
function nextCursor(
  reads: readonly WardrobeRead[],
  last: FeedItem | undefined,
  next: FeedItem | undefined,
): ChangesCursor {
  const nextRank = next
    ? reads.findIndex((read) => read.ownerId === next.ownerId)
    : reads.length;
  const positions = new Map<number, Position>();
  reads.forEach((read, rank) => {
    if (rank < nextRank) {
      positions.set(read.ownerId, endOf(read.revision, read.at.floor));
    } else if (rank === nextRank && last?.ownerId === read.ownerId) {
      positions.set(read.ownerId, {
        revision: last.revision,
        kind: last.kind,
        resource: last.resource,
        id: last.id,
        seq: last.seq,
        floor: read.at.floor,
      });
    } else if (read.at.revision >= 0) {
      positions.set(read.ownerId, read.at);
    }
    // A wardrobe not reached yet stays out: it starts fresh next time, at
    // the floor of then.
  });
  return { coverage: FEED_COVERAGE, positions };
}
