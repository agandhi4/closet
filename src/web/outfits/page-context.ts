import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { IsoDate } from '../../calendar-date';
import { type DayChoice, readDayChoice } from '../calendar/day-choice';
import { entriesOfDaySql } from '../calendar/queries';
import type { OutfitCount } from '../../wardrobe/goes-with';
import type { DayDestination } from './destination';
import {
  type MuseOutfit,
  museOutfitsSql,
  museUnlocksInputsSql,
  readMuseUnlocks,
} from './proposals';
import {
  type OutfitActivity,
  outfitActivitySql,
  type GarmentOutfit,
  savedOutfitsSql,
  type OutfitPageDetail,
  type OutfitEntries,
  outfitDetailSql,
  outfitEntriesSql,
  readOutfitEntries,
} from './queries';

/**
 * The Outfits pages' reads, each page in one statement (selectScalars):
 * the parts share no rows, and each was its own round trip until #164
 * (production reaches Postgres over a link where a statement costs ~114 ms,
 * #156).
 */

/** What GET /outfits shows (list-page.tsx). */
export interface SavedContext {
  /** The owner's own outfits, newest first: the tiles (ownersOutfit). */
  outfits: GarmentOutfit[];
  /**
   * Muse's outfits not the owner's yet (awaiting them, or set aside), and
   * what each piece to buy unlocks; none while picking for a day.
   */
  muse: { outfits: MuseOutfit[]; unlocks: Map<number, OutfitCount> };
  /** Each tile's line (worn count, next plan), by outfit id; absent: never planned. */
  activity: Map<number, OutfitActivity>;
  /** With `?for=day:`: what is on that day (the picking grid's disabled tiles). */
  choice: DayChoice | undefined;
}

/**
 * The Saved tab's tiles and their activity, Muse's outfits with what their
 * pieces to buy unlock (#335), and with a day to pick for, that day's
 * entries (readDayChoice: the plan page's rule): one statement.
 */
export async function savedContext(
  db: Db,
  ownerId: number,
  today: IsoDate,
  day: DayDestination | undefined,
): Promise<SavedContext> {
  const row = await selectScalars(db, {
    outfits: savedOutfitsSql(ownerId),
    activity: outfitActivitySql(ownerId, today),
    entries: day && entriesOfDaySql(ownerId, day.day),
    // Picking for a day is its own task: Muse's section stays out of it.
    muse: day ? undefined : museOutfitsSql(ownerId),
    unlocks: day ? undefined : museUnlocksInputsSql(ownerId),
  });
  return {
    outfits: row.outfits,
    muse: {
      outfits: row.muse ?? [],
      unlocks: row.unlocks ? readMuseUnlocks(row.unlocks) : new Map(),
    },
    activity: new Map(
      row.activity.map(({ outfitId, ...activity }) => [outfitId, activity]),
    ),
    choice: day && row.entries && readDayChoice(row.entries, day),
  };
}

/** What GET /outfits/:id shows (show-page.tsx). */
export interface OutfitContext {
  outfit: OutfitPageDetail;
  entries: OutfitEntries;
}

/**
 * The owner's outfit and its entries (planned, and the Worn strip), in one
 * statement; undefined when the outfit is not theirs (its entries are
 * read by owner too, so none are).
 */
export async function outfitContext(
  db: Db,
  id: number,
  ownerId: number,
  today: IsoDate,
): Promise<OutfitContext | undefined> {
  const row = await selectScalars(db, {
    outfit: outfitDetailSql(id, ownerId),
    entries: outfitEntriesSql(id, ownerId, today),
  });
  return row.outfit === null
    ? undefined
    : { outfit: row.outfit, entries: readOutfitEntries(row.entries) };
}
