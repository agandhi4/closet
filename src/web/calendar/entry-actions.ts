import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { IsoDate } from '../../calendar-date';
import type { Occasion } from '../../wardrobe/occasions';
import { unkeyedPhoto } from '../files/image-variant';
import type { Photos } from '../files/photos';
import { outfitNotFound } from '../outfits/outfit-actions';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { type EntryWornOutcome, setEntryWorn } from '../wears/queries';
import type { CalendarEntry } from './calendar-view';
import {
  deleteEntry,
  findEntry,
  type Scheduled,
  scheduleOutfit,
} from './queries';

/**
 * The calendar entry path (#188; docs/plans/2026-11-12-json-api.md section
 * 4): every surface's read of one entry and change to one, each taking the
 * Actor and refusing itself, so a page, an MCP tool and the API refuse
 * alike. Entries are private (AGENTS.md): only the actor's own are
 * reached, whatever wardrobe shares they hold, so another's entry is the
 * 404 of an unknown id, never a 403. The owner-scoped queries underneath
 * (queries.ts, setEntryWorn) trust their `ownerId`: only this path and
 * replaceEntryOutfit (replace.ts) reach them from a surface.
 */

/** Another's entry or no entry: one refusal for both (ids reveal nothing). */
export function calendarEntryNotFound(): NotFound {
  return new NotFound('calendarEntry');
}

/**
 * Plans the actor's outfit on a day (POST /calendar, schedule_outfit):
 * scheduleOutfit's answer, the occasion it is on that day included; an
 * outfit not theirs is NotFound('outfit').
 */
export async function planOutfit(
  db: Db,
  actor: Actor,
  entry: { outfitId: number; day: IsoDate; occasion: Occasion },
): Promise<Scheduled & { occasion: Occasion }> {
  const scheduled = await scheduleOutfit(db, {
    ownerId: actor.userId,
    ...entry,
  });
  if (scheduled === 'no-such-outfit') throw outfitNotFound();
  return scheduled;
}

/**
 * Marks the actor's entry worn or not (`worn` undefined toggles), its
 * wears with it (setEntryWorn); 'future' for a day still to come, which
 * each surface answers its own way (the pill's 409, mark_worn's 400).
 */
export async function markEntryWorn(
  db: Db,
  actor: Actor,
  input: {
    entryId: number;
    worn: boolean | undefined;
    at: Date;
    today: IsoDate;
  },
): Promise<Exclude<EntryWornOutcome, 'not-found'>> {
  const outcome = await setEntryWorn(db, { ...input, ownerId: actor.userId });
  if (outcome === 'not-found') throw calendarEntryNotFound();
  return outcome;
}

/**
 * The actor's entry as the week draws it (findEntry), for a row redrawn
 * alone after its worn write: gone meanwhile (deleted in another tab) is
 * the 404 too.
 */
export async function requireEntry(
  db: Db,
  actor: Actor,
  entry: { id: number; day: IsoDate },
  today: IsoDate,
): Promise<CalendarEntry> {
  const found = await findEntry(db, actor.userId, entry, today);
  if (!found) throw calendarEntryNotFound();
  return found;
}

/**
 * POST /calendar/:id/delete: deletes the actor's entry with its wears and
 * its selfie's row (deleteEntry, one transaction), then the selfie's bytes,
 * which no transaction holds (AGENTS.md Gotchas, "The DB cascade deletes
 * rows, never bytes").
 */
export async function removeEntry(
  { db, photos, logger }: { db: Db; photos: Photos; logger: Logger },
  actor: Actor,
  id: number,
): Promise<void> {
  const outcome = await deleteEntry(db, id, actor.userId);
  if (outcome === 'not-found') throw calendarEntryNotFound();
  // Only after commit: an unlink cannot be rolled back.
  for (const fileName of outcome.selfies) {
    await photos.deleteVariants(unkeyedPhoto(fileName));
  }
  logger.info(
    `Calendar entry ${id} deleted by user ${actor.userId}${
      outcome.selfies.length > 0
        ? ` with its selfie ${outcome.selfies.join(', ')}`
        : ''
    }`,
  );
}
