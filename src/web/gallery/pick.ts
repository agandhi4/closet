import type { FastifyReply } from 'fastify';
import type { IsoDate } from '../../calendar-date';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { Occasion } from '../../wardrobe/occasions';
import {
  type EntryTarget,
  replaceEntryOutfit,
  replaceMessage,
} from '../calendar/replace';
import { HttpError } from '../errors';
import { garmentsGoneError } from '../outfits/gone-garments';
import {
  type DayDestination,
  destinationTarget,
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import type { TripOutfitAdded } from '../trips/queries';
import { pickIdeaForTrip } from '../trips/trip-actions';
import { tripUrl } from '../trips/urls';
import { pickIdea, type PickResult } from '../outfits/pick';
import type { Actor } from '../sharing/access';
import { alreadySavedParam } from './urls';

/**
 * Garments becoming an outfit where the person is going (its
 * OutfitDestination), answered as a redirect: the gallery's pick (an idea's
 * card) and Styling's Save of a new outfit (#42), so the two never differ
 * in what a destination does. Each branch is one transaction and happens
 * once (a double tap finds what the first made):
 * - `day` with `replace` (#69): the outfit takes that entry's place
 *   (replaceEntryOutfit, which throws its refusals); to the week.
 * - `day`: saved and planned on it (pickIdea); to the week.
 * - `none`: saved (pickIdea); to the outfit.
 * - `trip` (#10): saved and added to the trip, for its day and occasion
 *   when given (pickIdeaForTrip, which refuses itself); to the trip.
 * Garments that are not all the owner's, in the closet, refuse the pick
 * with nothing written: OutfitGarmentsGone, naming them (#219; a 409 for
 * an archived one, a 404 for one that is not theirs), which Styling's Save
 * answers with its page, the rows kept. When they already were an outfit
 * it is reused, and the redirect says so (ALREADY_SAVED_FLAG). `name`
 * names a new outfit; without it pickIdea names it for its garments.
 * pickGarments is every branch but `replace` without the redirect: the
 * API's pick (POST /outfit-picks) calls it.
 */

/** The most garments a card holds: a template, a layer and a locked piece or two. */
export const MAX_PICKED = 8;

export interface PickDeps {
  db: Db;
  logger: Logger;
}

/** Who picked, for the log line: a gallery card, or Styling's Save. */
export type PickSource = 'idea' | 'styling';

const PICKED: Record<PickSource, string> = {
  idea: 'Idea picked',
  styling: 'Outfit styled',
};

export function pickTo(
  deps: PickDeps,
  reply: FastifyReply,
  actor: Actor,
  destination: OutfitDestination,
  garmentIds: number[],
  options: { source: PickSource; name?: string },
): Promise<FastifyReply> {
  if (destination.kind === 'day' && destination.replace !== undefined) {
    const { replace: entryId, day, occasion } = destination;
    const target = { entryId, day, occasion };
    return pickInPlace(deps, reply, actor, target, garmentIds, options);
  }
  return pickAndRedirect(deps, reply, actor, destination, garmentIds, options);
}

/**
 * A write's destination (the posted `for`, `occasion` and `replace`,
 * DestinationFields): its `for` must read back as posted (the schema
 * checked the shape; parseDestination the dates), so a trip's malformed day
 * is a 400, not a pick for no day; and `replace` needs a day.
 */
export function postedDestination(body: {
  for?: string;
  occasion?: string;
  replace?: number;
}): OutfitDestination {
  const destination = parseDestination(body);
  if (
    body.for !== undefined &&
    (destination.kind === 'none' || destinationTarget(destination) !== body.for)
  ) {
    throw new HttpError(400, 'body/for must be a real day or trip');
  }
  if (body.replace !== undefined && destination.kind !== 'day') {
    throw new HttpError(400, 'body/replace needs a day');
  }
  return destination;
}

async function pickInPlace(
  { db, logger }: PickDeps,
  reply: FastifyReply,
  actor: Actor,
  target: EntryTarget,
  garmentIds: number[],
  options: { name?: string },
): Promise<FastifyReply> {
  const replaced = await replaceEntryOutfit(db, actor, target, {
    garmentIds,
    name: options.name,
  });
  logger.info(replaceMessage(actor.userId, target, replaced));
  const flag = alreadySavedParam(replaced);
  return reply.redirect(
    `/calendar?week=${target.day}${flag && `&${flag}`}`,
    303,
  );
}

/**
 * Where pickGarments puts a new outfit: nowhere but the outfits, a day, or
 * a trip. Replacing an entry's outfit is the entry's own write
 * (replaceEntryOutfit: pickTo's `replace`, PUT /calendar-entries/{id}/outfit).
 */
export type PickDestination =
  | Extract<OutfitDestination, { kind: 'none' | 'trip' }>
  | Omit<DayDestination, 'replace'>;

/** What a pick made of the garments, and where it went. */
export type Picked =
  | {
      kind: 'saved';
      outfit: PickResult;
      plan: { day: IsoDate; occasion: Occasion } | undefined;
    }
  | {
      kind: 'trip';
      outfit: PickResult;
      tripId: number;
      added: TripOutfitAdded;
    };

/**
 * The garments become an outfit (or are found one already) where the
 * destination says, refused whole and logged: pickIdea for a day or none,
 * pickIdeaForTrip for a trip. pickTo's (the gallery's pick, Styling's
 * Save) and the API's POST /outfit-picks (#193c), so the surfaces never
 * differ in what a pick does; `via` marks the API's log lines.
 */
export async function pickGarments(
  { db, logger }: PickDeps,
  actor: Actor,
  destination: PickDestination,
  garmentIds: readonly number[],
  options: { source: PickSource; name?: string; via?: string },
): Promise<Picked> {
  const via = options.via ?? '';
  const who = `${PICKED[options.source]} by user ${actor.userId}`;
  if (destination.kind === 'trip') {
    const { tripId, day, occasion } = destination;
    const { outfit, added } = await pickIdeaForTrip(db, actor, {
      tripId,
      day,
      occasion,
      garmentIds,
      name: options.name,
    });
    logger.info(
      `${who} for trip ${tripId}${via}: ${outfit.alreadySaved ? 'existing ' : ''}outfit ${outfit.id} of garments ${garmentIds.join(', ')}, ${added === 'added' ? 'added' : 'already on the trip'} (${day ?? 'any day'}${occasion ? `, ${occasion}` : ''})`,
    );
    return { kind: 'trip', outfit, tripId, added };
  }
  const plan =
    destination.kind === 'day'
      ? { day: destination.day, occasion: destination.occasion }
      : undefined;
  const outfit = await pickIdea(db, actor.userId, {
    garmentIds,
    plan,
    name: options.name,
  });
  if (outfit === 'not-found') {
    throw await garmentsGoneError(db, actor.userId, garmentIds, 'closet');
  }
  logger.info(pickMessage(`${who}${via}`, garmentIds, outfit, plan));
  return { kind: 'saved', outfit, plan };
}

async function pickAndRedirect(
  deps: PickDeps,
  reply: FastifyReply,
  actor: Actor,
  destination: PickDestination,
  garmentIds: number[],
  options: { source: PickSource; name?: string },
): Promise<FastifyReply> {
  const picked = await pickGarments(
    deps,
    actor,
    destination,
    garmentIds,
    options,
  );
  if (picked.kind === 'trip') {
    return reply.redirect(tripUrl(picked.tripId, '?picked=1'), 303);
  }
  // A pick of an outfit that exists (a double tap, a retried post) is a
  // success too; the page it lands on says so.
  const flag = alreadySavedParam(picked.outfit);
  return reply.redirect(
    picked.plan
      ? `/calendar?week=${picked.plan.day}${flag && `&${flag}`}`
      : `/outfits/${picked.outfit.id}${flag && `?${flag}`}`,
    303,
  );
}

function pickMessage(
  who: string,
  garmentIds: readonly number[],
  picked: PickResult,
  plan: { day: string; occasion: string } | undefined,
): string {
  const garments = garmentIds.join(', ');
  if (!picked.alreadySaved) {
    const where = plan ? `, planned ${plan.day} (${plan.occasion})` : ', saved';
    return `${who}: outfit ${picked.id} of garments ${garments}${where}`;
  }
  const where = plan
    ? `, ${picked.schedule} ${plan.day} (${plan.occasion})`
    : '';
  const adopted = picked.adopted ? '; taken over from the week planner' : '';
  return `${who}: garments ${garments} already outfit ${picked.id}${where}; nothing created${adopted}`;
}
