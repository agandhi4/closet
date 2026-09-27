import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import { itemTitle } from '../plans/labels';
import { findOwnedItem, findPlan } from '../plans/queries';
import { itemNotFound } from '../plans/validation';
import type { WardrobeAccess } from '../sharing/access';
import type { EntryStatus } from '../../wardrobe/status';
import { changeCandidates, requireCandidateRoom } from '../plans/candidates';
import type { WithGarment } from './writes';
import { findGarment, type GarmentDetail } from './queries';
import { TO_CLOSET, type Destination } from './urls';
import {
  BLANK_CARE,
  BLANK_GARMENT_VALUES,
  type DestinationQuery,
  type GarmentBody,
  type GarmentFormValues,
  storedPropertyValues,
} from './validation';
import { splitColors } from './garment';

/** The plan item a new wishlist item is a candidate for, as the form names it. */
export interface CandidateFor {
  id: number;
  title: string;
  planName: string;
}

/**
 * The plan item `planItemId` a new wishlist item in the wardrobe `access`
 * addresses is to be a candidate for (34b). Plans are the requester's own,
 * so only in their own wardrobe and only an item of their own plans; any
 * other is a 404 like an unknown id (a grantee has no plans here).
 */
export async function resolveCandidateFor(
  db: Db,
  planItemId: number,
  access: WardrobeAccess,
): Promise<CandidateFor> {
  const item = access.isOwner
    ? await findOwnedItem(db, planItemId, access.ownerId)
    : undefined;
  const plan = item && (await findPlan(db, item.planId, access.ownerId));
  if (!item || !plan) throw itemNotFound();
  // A new garment is never already one of its candidates: a full item is
  // refused before the form is filled in, or a garment or photo stored.
  await requireCandidateRoom(db, item.id);
  return { id: item.id, title: itemTitle(item), planName: plan.name };
}

/**
 * A new garment's post's destination (POST /wardrobe): the closet or the
 * wishlist, and for a plan item's "Add a candidate" (34b) the item, checked
 * before anything is stored (resolveCandidateFor), with its candidate link
 * to write in the garment's own transaction.
 */
export async function postedDestination(
  db: Db,
  body: Pick<GarmentBody, 'to' | 'planItem'>,
  access: WardrobeAccess,
): Promise<{
  destination: Destination & { to: EntryStatus };
  candidateFor?: CandidateFor;
  linkCandidate?: WithGarment;
}> {
  const to = body.to ?? 'closet';
  if (to !== 'wishlist' || !body.planItem) return { destination: { to } };
  const candidateFor = await resolveCandidateFor(db, body.planItem, access);
  return {
    destination: { to, planItem: candidateFor.id },
    candidateFor,
    linkCandidate: (tx, garmentId) =>
      changeCandidates(tx, access.ownerId, {
        add: { itemIds: [candidateFor.id], garmentIds: [garmentId] },
      }),
  };
}

/**
 * Where a new garment's form lands, from its URL (DestinationQuery): the
 * closet, the wishlist, the wishlist as a replacement for a garment of the
 * addressed wardrobe (a garment's "Find a replacement"; any other id is a
 * 404 like an unknown garment), or the wishlist as a candidate for one of
 * the requester's plan items (resolveCandidateFor). Shared by GET
 * /wardrobe/new and the link import's routes, which carry it through to
 * the form.
 */
export async function resolveDestination(
  db: Db,
  query: DestinationQuery,
  access: WardrobeAccess,
): Promise<{
  destination: Destination;
  replaced?: GarmentDetail;
  candidateFor?: CandidateFor;
}> {
  if (query.to !== 'wishlist') return { destination: TO_CLOSET };
  const [replaced, candidateFor] = await Promise.all([
    query.replaces ? findGarment(db, query.replaces, access.ownerId) : null,
    query.planItem ? resolveCandidateFor(db, query.planItem, access) : null,
  ]);
  if (replaced === undefined) throw new HttpError(404, 'Garment not found');
  return {
    destination: {
      to: 'wishlist',
      ...(replaced && { replaces: replaced.id }),
      ...(candidateFor && { planItem: candidateFor.id }),
    },
    replaced: replaced ?? undefined,
    candidateFor: candidateFor ?? undefined,
  };
}

/**
 * A new garment form's values: blank (the closet's, or a wishlist item's),
 * or for a replacement what describes
 * the kind of garment (category, type and the other properties, brand,
 * colours, size), never what belonged to the old one (its name, notes,
 * dates, price, link, care).
 */
export function destinationValues(
  destination: Destination,
  replaced: GarmentDetail | undefined,
): GarmentFormValues {
  const replaces =
    destination.replaces === undefined ? '' : String(destination.replaces);
  if (!replaced) return { ...BLANK_GARMENT_VALUES, replaces };
  return {
    ...BLANK_GARMENT_VALUES,
    category: replaced.category,
    brand: replaced.brand ?? '',
    colors: splitColors(replaced.color),
    size: replaced.size ?? '',
    properties: storedPropertyValues(replaced),
    care: BLANK_CARE,
    replaces,
  };
}
