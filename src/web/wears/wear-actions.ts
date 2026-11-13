import type { IsoDate } from '../../calendar-date';
import type { AwayReason } from '../../wardrobe/availability';
import type { Db } from '../../db/client';
import type { HttpError } from '../errors';
import type { Actor } from '../sharing/access';
import { garmentNotOwnedYet } from '../wardrobe/garment-actions';
import {
  type GarmentAddress,
  garmentNotFound,
  garmentWardrobe,
} from '../wardrobe/garment-access';
import { findGarment } from '../wardrobe/queries';
import { markWashed, setAway, setWoreToday } from './queries';

/**
 * The wear path (#188, #193a): Wore today, Washed and away on one garment,
 * each taking the Actor and the garment's address and refusing itself, so
 * the garment page (routes.tsx) and the API (api-routes.ts) refuse alike.
 * The owner's own records: a grantee who sees the garment is a 403 through
 * `?ownerId=` and a 404 without it, where it is not in their wardrobe
 * (garmentWardrobe's `own`, free on one's own wardrobe). Each writer
 * judges the garment in its own statement (queries.ts), so a write that
 * lands reads nothing first (#160); only one that changed nothing reads
 * the garment to say why: not the owner's (404) or a wishlist item, not
 * owned yet (409). Callers parse, call and answer; the day is theirs to
 * judge (today, or a queued tap's within the window).
 */

/** What a wear or wash did, in whose wardrobe (always the actor's own). */
export interface WearWrite {
  ownerId: number;
  /** False for one that already was so: a retry, a replayed tap. */
  changed: boolean;
}

/** Wore it on `day` (worn) or its undo that day, the garment's own day-level wear (setWoreToday). */
export async function wearGarment(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
  change: { day: IsoDate; worn: boolean },
): Promise<WearWrite> {
  const { access } = await garmentWardrobe(db, actor, address, 'own');
  const outcome = await setWoreToday(db, {
    garmentId: address.id,
    ownerId: access.ownerId,
    ...change,
  });
  if (outcome === 'not-found') throw garmentNotFound();
  if (outcome === 'wishlist') throw garmentNotOwnedYet();
  return { ownerId: access.ownerId, changed: outcome === 'changed' };
}

/** Washed on `day` (markWashed: a wash never moves back, so an older one is unchanged). */
export async function washGarment(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
  day: IsoDate,
): Promise<WearWrite> {
  const { access } = await garmentWardrobe(db, actor, address, 'own');
  const [washed] = await markWashed(db, access.ownerId, [address.id], day);
  if (!washed) throw await refusalOf(db, address.id, access.ownerId);
  return { ownerId: access.ownerId, changed: washed.changed };
}

/** Away (lent, at the repair shop) with a note, or back in the closet (null): setAway. */
export async function putGarmentAway(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
  away: { reason: AwayReason; note: string | null } | null,
): Promise<{ ownerId: number }> {
  const { access } = await garmentWardrobe(db, actor, address, 'own');
  if (!(await setAway(db, access.ownerId, address.id, away))) {
    throw await refusalOf(db, address.id, access.ownerId);
  }
  return { ownerId: access.ownerId };
}

/** Why a writer that answers only whether it wrote (markWashed, setAway) wrote nothing. */
async function refusalOf(
  db: Db,
  id: number,
  ownerId: number,
): Promise<HttpError> {
  const garment = await findGarment(db, id, ownerId);
  return garment?.status === 'wishlist'
    ? garmentNotOwnedYet()
    : garmentNotFound();
}
