import type { Queryable } from '../../db/client';
import type { Occasion } from '../../wardrobe/occasions';
import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import { pickIdea } from '../gallery/ideas';
import { t } from '../i18n';
import { detachEntrySelfie } from '../selfies/queries';
import {
  plannerCreatedOutfit,
  removeUnheldOutfits,
} from '../week-plan/queries';
import type { IsoDate } from './calendar-date';
import { occasionLabel } from './labels';
import {
  entryOf,
  lockEntryToReplace,
  ownsOutfit,
  setEntryOutfit,
} from './queries';

/**
 * Changing a planned outfit in place (#69): Today's "Change", the calendar
 * row's Change and the plan page, through POST /calendar and the gallery's
 * pick with `replace=` (OutfitDestination), and the MCP tool
 * schedule_outfit's `replaceEntryId`. One entry stays for the occasion; it
 * is never a delete and a new entry.
 *
 * The rules, decided in #69:
 * - **A worn entry is refused** ('worn'): it is the record of what was
 *   worn, and its wears are snapshots of that outfit's garments (#7). The
 *   person adds another outfit to the day instead; Today and the calendar
 *   offer Change only on an unworn entry.
 * - **Its selfie is kept as a look on its day** (detachEntrySelfie): the
 *   photo shows the old outfit, so it must not move to the new one, and
 *   deleting it would lose a record, the #19 rule for a deleted outfit. An
 *   unworn entry has one only when it was unmarked after the photo.
 * - **The choice becomes the person's** (planned_by 'user', setEntryOutfit):
 *   the re-plan and Undo leave it alone (#16). Also when it is the outfit
 *   the entry already had: choosing what the planner chose takes the entry
 *   over (`adopted`), as planning it does (insertEntry).
 * - **An outfit "Plan my week" created for the entry goes** once nothing
 *   holds it (removeUnheldOutfits, Undo's rule), but only while the entry
 *   was still 'auto': one the person took over is theirs.
 * - **The new outfit already on that day** is refused ('already-on-day',
 *   naming its occasion): an outfit is on a day once (the unique key).
 *
 * Idempotent: everything runs in one transaction under the owner lock
 * (ownerTransaction, which every calendar writer takes), so a double tap's second
 * request waits for the first, finds the entry already holding the outfit
 * (a picked idea resolves to the outfit the first one created) and changes
 * nothing ('unchanged').
 */

/**
 * What the entry gets: a saved outfit of the owner's, or garments (an
 * idea's, Styling's rows) through pickIdea, named `name` when they are not
 * an outfit yet.
 */
export type ReplacementChoice =
  | { outfitId: number }
  | { garmentIds: readonly number[]; name?: string };

export interface EntryTarget {
  entryId: number;
  day: IsoDate;
  /** The entry's occasion, checked when given (the pages always give it). */
  occasion?: Occasion;
}

/** The entry holds the chosen outfit: changed now, or already (a double tap). */
export interface Replaced {
  outcome: 'replaced' | 'unchanged';
  entryId: number;
  /** The entry's occasion, which a replace keeps. */
  occasion: Occasion;
  outfitId: number;
  previousOutfitId: number;
  /** The outfit existed already: a saved one, or an idea's garments pickIdea found saved. */
  alreadySaved: boolean;
  /** The selfie kept as a look on the day, if the entry had one. */
  selfieDetached?: number;
  /** Planner-made outfits removed with the swap (0 or 1). */
  outfitsRemoved: number;
  /** The entry was the week planner's ('auto') and is now the person's. */
  adopted: boolean;
}

export type ReplaceOutcome = Replaced | ReplaceRefused;

/** Nothing was written. */
export type ReplaceRefused =
  /** Not the owner's entry, or not on that day and occasion. */
  | { outcome: 'entry-not-found' }
  /** The saved outfit is not the owner's. */
  | { outcome: 'outfit-not-found' }
  /** An idea's garments are not all in the owner's closet (a card from before an archive). */
  | { outcome: 'garments-not-found' }
  | { outcome: 'worn' }
  | { outcome: 'already-on-day'; outfitId: number; occasion: Occasion };

export function replaceEntryOutfit(
  db: Queryable,
  ownerId: number,
  target: EntryTarget,
  choice: ReplacementChoice,
): Promise<ReplaceOutcome> {
  return ownerTransaction(db, ownerId, 'replaceEntryOutfit', async (tx) => {
    const entry = await lockEntryToReplace(tx, ownerId, target);
    if (!entry) return { outcome: 'entry-not-found' };
    // Before the choice: a refused replace must not save an idea either.
    if (entry.worn) return { outcome: 'worn' };
    const chosen = await chosenOutfit(tx, ownerId, choice);
    if (!chosen) {
      return {
        outcome:
          'outfitId' in choice ? 'outfit-not-found' : 'garments-not-found',
      };
    }
    const result = {
      adopted: entry.plannedBy === 'auto',
      entryId: entry.id,
      occasion: entry.occasion,
      outfitId: chosen.id,
      previousOutfitId: entry.outfitId,
      alreadySaved: chosen.alreadySaved,
    };
    if (chosen.id === entry.outfitId) {
      if (result.adopted) await setEntryOutfit(tx, entry.id, chosen.id);
      return { outcome: 'unchanged', ...result, outfitsRemoved: 0 };
    }
    // Only an outfit that already existed can be on the day: a created one
    // is new. Nothing was written yet, so refusing needs no rollback.
    const onDay = await entryOf(tx, ownerId, target.day, chosen.id);
    if (onDay) {
      return {
        outcome: 'already-on-day',
        outfitId: chosen.id,
        occasion: onDay.occasion,
      };
    }
    const plannerMade =
      result.adopted && (await plannerCreatedOutfit(tx, entry.id));
    await setEntryOutfit(tx, entry.id, chosen.id);
    const selfieDetached = await detachEntrySelfie(tx, entry.id);
    const outfitsRemoved = plannerMade
      ? await removeUnheldOutfits(tx, ownerId, [entry.outfitId])
      : 0;
    return { outcome: 'replaced', ...result, selfieDetached, outfitsRemoved };
  });
}

async function chosenOutfit(
  tx: Queryable,
  ownerId: number,
  choice: ReplacementChoice,
): Promise<{ id: number; alreadySaved: boolean } | undefined> {
  if ('outfitId' in choice) {
    return (await ownsOutfit(tx, ownerId, choice.outfitId))
      ? { id: choice.outfitId, alreadySaved: true }
      : undefined;
  }
  // No plan: the entry is changed below, not added.
  const picked = await pickIdea(tx, ownerId, {
    garmentIds: choice.garmentIds,
    name: choice.name,
  });
  return picked === 'not-found' ? undefined : picked;
}

/** Why a refused replace changed nothing, for its log line. */
function refusalReason(outcome: ReplaceRefused): string {
  switch (outcome.outcome) {
    case 'worn':
      return 'it is worn';
    case 'already-on-day':
      return `outfit ${outcome.outfitId} is already on the day (${outcome.occasion})`;
    case 'entry-not-found':
      return 'not their entry there';
    case 'outfit-not-found':
      return 'the outfit is not theirs';
    case 'garments-not-found':
      return 'a garment is not in their closet';
  }
}

/** What a replace changed, for its log line. */
function changeSummary(outcome: Replaced): string {
  const parts = [
    `outfit ${outcome.previousOutfitId} -> ${outcome.alreadySaved ? '' : 'new '}outfit ${outcome.outfitId}`,
  ];
  if (outcome.selfieDetached !== undefined) {
    parts.push(`selfie ${outcome.selfieDetached} kept as a look`);
  }
  if (outcome.outfitsRemoved > 0) {
    parts.push(`planner's outfit ${outcome.previousOutfitId} removed`);
  }
  return parts.join(', ');
}

/** The log line for a replace's outcome (context Web; `via` marks the MCP tool). */
export function replaceMessage(
  ownerId: number,
  target: EntryTarget,
  outcome: ReplaceOutcome,
  via = '',
): string {
  const occasion = target.occasion ? ` ${target.occasion}` : '';
  const entry = `Calendar entry ${target.entryId} (${target.day}${occasion})`;
  if (isRefused(outcome)) {
    return `${entry} not changed for user ${ownerId}${via}: ${refusalReason(outcome)}`;
  }
  if (outcome.outcome === 'unchanged') {
    return outcome.adopted
      ? `${entry} already holds outfit ${outcome.outfitId}; taken over from the week planner by user ${ownerId}${via}`
      : `${entry} already holds outfit ${outcome.outfitId} for user ${ownerId}${via}; nothing changed`;
  }
  return `${entry} changed by user ${ownerId}${via}: ${changeSummary(outcome)}`;
}

export function isRefused(outcome: ReplaceOutcome): outcome is ReplaceRefused {
  return outcome.outcome !== 'replaced' && outcome.outcome !== 'unchanged';
}

/**
 * The error a route or tool answers a refusal with. Another's entry is a
 * 404 like a missing one (ids reveal nothing); a worn entry and an outfit
 * already on the day are 409s that say what to do instead.
 */
export function replaceRefusal(outcome: ReplaceRefused): HttpError {
  switch (outcome.outcome) {
    case 'entry-not-found':
      return new HttpError(404, 'Calendar entry not found');
    case 'outfit-not-found':
      return new HttpError(404, 'Outfit not found');
    case 'garments-not-found':
      return new HttpError(404, 'Garment not found');
    case 'worn':
      return new HttpError(409, t('changeEntry.REFUSED_WORN'));
    case 'already-on-day':
      return new HttpError(
        409,
        t('changeEntry.REFUSED_ON_DAY', {
          occasion: occasionLabel(outcome.occasion),
        }),
      );
  }
}
