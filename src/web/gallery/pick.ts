import type { FastifyReply } from 'fastify';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import {
  type EntryTarget,
  isRefused,
  replaceEntryOutfit,
  replaceMessage,
  replaceRefusal,
} from '../calendar/replace';
import { HttpError } from '../errors';
import { garmentsGoneError } from '../outfits/gone-garments';
import {
  destinationTarget,
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import { pickForTrip } from '../trips/queries';
import { tripUrl } from '../trips/urls';
import { tripNotFound } from '../trips/validation';
import { pickIdea, type PickResult } from '../outfits/pick';
import { alreadySavedParam } from './urls';

/**
 * Garments becoming an outfit where the person is going (its
 * OutfitDestination), answered as a redirect: the gallery's pick (an idea's
 * card) and Styling's Save of a new outfit (#42), so the two never differ
 * in what a destination does. Each branch is one transaction and happens
 * once (a double tap finds what the first made):
 * - `day` with `replace` (#69): the outfit takes that entry's place
 *   (replaceEntryOutfit); to the week. A refusal throws.
 * - `day`: saved and planned on it (pickIdea); to the week.
 * - `none`: saved (pickIdea); to the outfit.
 * - `trip` (#10): saved and added to the trip, for its day and occasion
 *   when given (pickForTrip); to the trip.
 * Garments that are not all the owner's, in the closet, refuse the pick
 * with nothing written: OutfitGarmentsGone, naming them (#219; a 409 for
 * an archived one, a 404 for one that is not theirs), which Styling's Save
 * answers with its page, the rows kept. When they already were an outfit
 * it is reused, and the redirect says so (ALREADY_SAVED_FLAG). `name`
 * names a new outfit; without it pickIdea names it for its garments.
 */

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
  ownerId: number,
  destination: OutfitDestination,
  garmentIds: number[],
  options: { source: PickSource; name?: string },
): Promise<FastifyReply> {
  if (destination.kind === 'day' && destination.replace !== undefined) {
    const { replace: entryId, day, occasion } = destination;
    const target = { entryId, day, occasion };
    return pickInPlace(deps, reply, ownerId, target, garmentIds, options);
  }
  return destination.kind === 'trip'
    ? pickToTrip(deps, reply, ownerId, destination, garmentIds, options)
    : pickToDayOrSave(deps, reply, ownerId, destination, garmentIds, options);
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
  ownerId: number,
  target: EntryTarget,
  garmentIds: number[],
  options: { name?: string },
): Promise<FastifyReply> {
  const replaced = await replaceEntryOutfit(db, ownerId, target, {
    garmentIds,
    name: options.name,
  });
  logger.info(replaceMessage(ownerId, target, replaced));
  if (isRefused(replaced)) throw replaceRefusal(replaced);
  const flag = alreadySavedParam(replaced);
  return reply.redirect(
    `/calendar?week=${target.day}${flag && `&${flag}`}`,
    303,
  );
}

async function pickToDayOrSave(
  { db, logger }: PickDeps,
  reply: FastifyReply,
  ownerId: number,
  destination: Extract<OutfitDestination, { kind: 'day' | 'none' }>,
  garmentIds: number[],
  options: { source: PickSource; name?: string },
): Promise<FastifyReply> {
  const plan =
    destination.kind === 'day'
      ? { day: destination.day, occasion: destination.occasion }
      : undefined;
  const picked = await pickIdea(db, ownerId, {
    garmentIds,
    plan,
    name: options.name,
  });
  if (picked === 'not-found') {
    throw await garmentsGoneError(db, ownerId, garmentIds, 'closet');
  }
  logger.info(pickMessage(options.source, ownerId, garmentIds, picked, plan));
  // A pick of an outfit that exists (a double tap, a retried post) is a
  // success too; the page it lands on says so.
  const flag = alreadySavedParam(picked);
  return reply.redirect(
    plan
      ? `/calendar?week=${plan.day}${flag && `&${flag}`}`
      : `/outfits/${picked.id}${flag && `?${flag}`}`,
    303,
  );
}

async function pickToTrip(
  { db, logger }: PickDeps,
  reply: FastifyReply,
  ownerId: number,
  destination: Extract<OutfitDestination, { kind: 'trip' }>,
  garmentIds: number[],
  options: { source: PickSource; name?: string },
): Promise<FastifyReply> {
  const { tripId, day, occasion } = destination;
  const outcome = await pickForTrip(db, ownerId, {
    tripId,
    day,
    occasion,
    garmentIds,
    name: options.name,
  });
  if (outcome === 'no-trip') throw tripNotFound();
  if (outcome === 'not-a-trip-day') {
    throw new HttpError(400, 'body/for must name a day of the trip');
  }
  if (outcome === 'not-found') {
    throw await garmentsGoneError(db, ownerId, garmentIds, 'closet');
  }
  logger.info(
    `${PICKED[options.source]} by user ${ownerId} for trip ${tripId}: ${outcome.outfit.alreadySaved ? 'existing ' : ''}outfit ${outcome.outfit.id} of garments ${garmentIds.join(', ')}, ${outcome.added === 'added' ? 'added' : 'already on the trip'} (${day ?? 'any day'}${occasion ? `, ${occasion}` : ''})`,
  );
  return reply.redirect(tripUrl(tripId, '?picked=1'), 303);
}

function pickMessage(
  source: PickSource,
  ownerId: number,
  garmentIds: readonly number[],
  picked: PickResult,
  plan: { day: string; occasion: string } | undefined,
): string {
  const who = `${PICKED[source]} by user ${ownerId}`;
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
