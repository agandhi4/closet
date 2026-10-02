import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import { itemTitle } from '../plans/labels';
import { findOwnedItem, findPlan } from '../plans/queries';
import { itemNotFound } from '../plans/validation';
import type { WardrobeAccess } from '../sharing/access';
import type { EntryStatus } from '../../wardrobe/status';
import {
  CandidateForDeclinedItem,
  linkNewCandidate,
  requireCandidateRoom,
} from '../plans/candidates';
import { decideOrderItem, findPendingOrderItem } from './order-mail/queries';
import type { WithGarment } from './writes';
import { findGarment, type GarmentDetail } from './queries';
import { TO_CLOSET, type Destination } from './urls';
import {
  BLANK_CARE,
  BLANK_CARE_LABEL,
  BLANK_GARMENT_VALUES,
  type DestinationQuery,
  type GarmentBody,
  type GarmentFormValues,
  type PropertyFormValues,
  storedPropertyValues,
} from './validation';

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
  if (item.review === 'declined') throw new CandidateForDeclinedItem([item.id]);
  return { id: item.id, title: itemTitle(item), planName: plan.name };
}

/**
 * A new garment's post's destination (POST /wardrobe): the closet or the
 * wishlist, and for a plan item's "Add a candidate" (34b) the item, checked
 * before anything is stored (resolveCandidateFor), with its candidate link
 * to write in the garment's own transaction; for an order's "Add to
 * closet" (#25) the order item, checked the same way (resolveOrderItem),
 * marked added in that transaction.
 */
export async function postedDestination(
  db: Db,
  body: Pick<GarmentBody, 'to' | 'planItem' | 'orderItem'>,
  access: WardrobeAccess,
): Promise<{
  destination: Destination & { to: EntryStatus };
  candidateFor?: CandidateFor;
  withGarment?: WithGarment;
}> {
  const to = body.to ?? 'closet';
  if (to === 'closet' && body.orderItem) {
    const orderItem = await resolveOrderItem(db, body.orderItem, access);
    return {
      destination: { to, orderItem },
      withGarment: async (tx, garmentId) => {
        const added = await decideOrderItem(tx, orderItem, access.ownerId, {
          event: 'add',
          garmentId,
        });
        // Dismissed, or added by an earlier save of the same form, since
        // the check above: the garment rolls back with this.
        if (!added) throw new HttpError(409, 'Already added from your orders');
      },
    };
  }
  if (to !== 'wishlist' || !body.planItem) return { destination: { to } };
  const candidateFor = await resolveCandidateFor(db, body.planItem, access);
  return {
    destination: { to, planItem: candidateFor.id },
    candidateFor,
    withGarment: (tx, garmentId) =>
      linkNewCandidate(tx, access.ownerId, candidateFor.id, garmentId),
  };
}

/**
 * The order item `orderItemId` a new closet garment is added from: the
 * requester's own pending one, in their own wardrobe; anything else a 404
 * like an unknown id, before anything is stored.
 */
async function resolveOrderItem(
  db: Db,
  orderItemId: number,
  access: WardrobeAccess,
): Promise<number> {
  const item = access.isOwner
    ? await findPendingOrderItem(db, orderItemId, access.ownerId)
    : undefined;
  if (!item) throw new HttpError(404, 'Order item not found');
  return item.id;
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
    colors: replaced.colors ?? [],
    size: replaced.size ?? '',
    properties: withoutCareLabel(storedPropertyValues(replaced)),
    care: BLANK_CARE,
    replaces,
  };
}

/**
 * A replacement's properties without the old one's care label, which is
 * that garment's own: none chosen, and no materials behind the presets, so
 * the form's first refresh fills the label from the materials.
 */
function withoutCareLabel(values: PropertyFormValues): PropertyFormValues {
  return {
    ...values,
    ...BLANK_CARE_LABEL,
    preset: { ...values.preset, materials: '' },
  };
}
