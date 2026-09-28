import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { IsoDate } from '../calendar/calendar-date';
import { type DayChoice, readDayChoice } from '../calendar/day-choice';
import { entriesOfDaySql } from '../calendar/queries';
import type { DayDestination } from './destination';
import {
  type OutfitActivity,
  outfitActivitySql,
  type GarmentOutfit,
  savedOutfitsSql,
  type OutfitDetail,
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
  /** Every outfit of the owner's, newest first: the tiles. */
  outfits: GarmentOutfit[];
  /** Each tile's line (worn count, next plan), by outfit id; absent: never planned. */
  activity: Map<number, OutfitActivity>;
  /** With `?for=day:`: what is on that day (the picking grid's disabled tiles). */
  choice: DayChoice | undefined;
}

/**
 * The Saved tab's tiles and their activity, and with a day to pick for,
 * that day's entries (readDayChoice: the plan page's rule): one statement.
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
  });
  return {
    outfits: row.outfits,
    activity: new Map(
      row.activity.map(({ outfitId, ...activity }) => [outfitId, activity]),
    ),
    choice: day && row.entries && readDayChoice(row.entries, day),
  };
}

/** What GET /outfits/:id shows (show-page.tsx). */
export interface OutfitContext {
  outfit: OutfitDetail;
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
