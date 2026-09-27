import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment } from '../../db/schema';
import {
  type ClosetPiece,
  fitTargetTo,
  type ItemStatus,
  matchPlan,
  type TargetDifference,
  targetDifferences,
} from '../../wardrobe/plans';
import { isMaterial } from '../../wardrobe/properties';
import { deleteGarment } from '../wardrobe/queries';
import { buyGarment, type BuyOutcome, type Purchase } from '../wardrobe/status';
import type { WardrobeDeps } from '../wardrobe/writes';
import {
  type Candidacy,
  candidaciesOf,
  type CandidateGarment,
  candidatesOfItems,
} from './candidates';
import { toTarget } from './gaps';
import {
  closetPieces,
  itemFields,
  itemsOf,
  type PlanItemRow,
  updateItem,
} from './queries';
import type { PlanItemFields } from './validation';

/**
 * "Bought it" for a candidate product (#34, slice 34b; the rule, in full):
 *
 * - Buying is the wishlist's own `buy` (buyGarment, setGarmentStatus): the
 *   garment moves into the closet, and because matching is derived, the
 *   plan item it was bought for becomes owned (or partly) by itself, **if
 *   the garment is the kind of thing the item asks for**.
 * - If it is not (targetDifferences: "blue vs black"), the Bought it page
 *   says so before the purchase is confirmed, and offers to change the
 *   item to match (fitTargetTo, only what differs); left unticked, the
 *   item stays as it is and stays a gap. Nothing diverges silently.
 * - The item's other wishlist candidates are offered for removal from the
 *   wishlist (deleted: dropping a wishlist item is a delete), ticked when
 *   the purchase leaves the item owned and the candidate is a candidate of
 *   nothing else still short; otherwise listed unticked.
 * - The bought garment's candidate links are kept and stop mattering (read
 *   only through onWishlist). A MANAGE grantee may buy, but plans are the
 *   owner's: the plan part is offered to, and taken from, the owner alone.
 *
 * All of it is one transaction; the removed candidates' photo bytes go
 * after the commit (the photo contract).
 */

/** An item the garment is a candidate for, as the Bought it page shows it. */
export interface PlanPurchase {
  item: PlanItemRow;
  plan: { id: number; name: string; active: boolean };
  /** How the garment falls outside the item; empty when it matches. */
  differences: TargetDifference[];
  /**
   * The item's status once the garment is in the closet (matchPlan over the
   * closet with it); null for an item the owner's agent proposed and the
   * owner has not accepted (outside matching).
   */
  after: ItemStatus | null;
  /** The item's other wishlist candidates, and whether removing each is suggested. */
  others: { candidate: CandidateGarment; suggested: boolean }[];
}

/** A wishlist garment as a purchase judges it. */
export type BoughtPiece = Omit<ClosetPiece, 'condition'>;

/** Garment `id` of `ownerId`'s wardrobe as matching reads it, or undefined. */
export async function pieceOf(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<BoughtPiece | undefined> {
  const [row] = await db
    .select({
      id: garment.id,
      category: garment.category,
      type: garment.type,
      colors: garment.colors,
      materials: garment.materials,
      warmth: garment.warmth,
      formality: garment.formality,
      quantity: garment.quantity,
    })
    .from(garment)
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)));
  if (!row) return undefined;
  const { colors, materials, ...rest } = row;
  return {
    ...rest,
    colors: colors ?? [],
    materials: materials ?? [],
  };
}

/**
 * What buying `piece` (a wishlist garment of `ownerId`'s) does to the plan
 * items it is a candidate for: the Bought it page's plan section. Empty
 * when it is a candidate of nothing. Reads the candidacies, the plans'
 * items, the closet and the other candidates (four statements).
 */
export async function planPurchases(
  db: Queryable,
  ownerId: number,
  piece: BoughtPiece,
): Promise<PlanPurchase[]> {
  const candidacies = await candidaciesOf(db, ownerId, [piece.id]);
  if (candidacies.length === 0) return [];
  const planIds = [...new Set(candidacies.map((c) => c.planId))];
  const itemIds = candidacies.map((c) => c.itemId);
  const [items, closet, candidates] = await Promise.all([
    itemsOf(db, planIds),
    closetPieces(db, ownerId),
    candidatesOfItems(db, ownerId, itemIds),
  ]);
  // The closet as it will be: the purchase in it, in good condition.
  const withPurchase = [...closet, { ...piece, condition: 'good' as const }];
  const after = new Map<number, ItemStatus>();
  for (const planId of planIds) {
    const accepted = items.filter((i) => i.planId === planId && !i.proposed);
    const matches = matchPlan(accepted.map(toTarget), withPurchase);
    for (const match of matches) after.set(match.itemId, match.status);
  }
  const others = [...candidates.values()]
    .flat()
    .filter((candidate) => candidate.garmentId !== piece.id);
  const othersLinks = await candidaciesOf(db, ownerId, [
    ...new Set(others.map((c) => c.garmentId)),
  ]);
  // A candidate's removal is suggested only when every item it stands for
  // is one this purchase leaves owned: it is not needed anywhere else.
  const settled = (garmentId: number) =>
    othersLinks
      .filter((link) => link.garmentId === garmentId)
      .every((link) => after.get(link.itemId) === 'owned');
  const byId = new Map(items.map((item) => [item.id, item]));
  return candidacies.map((candidacy: Candidacy) => {
    const item = byId.get(candidacy.itemId)!;
    return {
      item,
      plan: {
        id: candidacy.planId,
        name: candidacy.planName,
        active: candidacy.planActive,
      },
      differences: targetDifferences(toTarget(item), piece),
      after: item.proposed ? null : (after.get(item.id) ?? null),
      others: (candidates.get(item.id) ?? [])
        .filter((candidate) => candidate.garmentId !== piece.id)
        .map((candidate) => ({
          candidate,
          suggested:
            after.get(item.id) === 'owned' && settled(candidate.garmentId),
        })),
    };
  });
}

/** `item`'s fields changed just enough for `piece` to match it (fitTargetTo). */
export function fittedItem(
  item: PlanItemRow,
  piece: BoughtPiece,
): PlanItemFields {
  const fitted = fitTargetTo(toTarget(item), piece);
  // Sets are null for none (the columns' rule), never an empty array.
  const set = <T>(values: T[]) => (values.length > 0 ? values : null);
  return {
    ...itemFields(item),
    category: fitted.category,
    type: fitted.type,
    colors: set([...fitted.colors]),
    materials: set(fitted.materials.filter(isMaterial)),
    warmthMin: fitted.warmth?.min ?? null,
    warmthMax: fitted.warmth?.max ?? null,
    formalityMin: fitted.formality?.min ?? null,
    formalityMax: fitted.formality?.max ?? null,
  };
}

/** What the owner chose on the Bought it page's plan section. */
export interface PlanFollowUps {
  /** Items to change to match the garment (only those it is a candidate for). */
  adjustItems: number[];
  /** Other candidates to remove from the wishlist (only of those items). */
  removeCandidates: number[];
}

export type CandidatePurchaseOutcome =
  | (BuyOutcome & { ok: false })
  | {
      ok: true;
      archivedReplaced: number | null;
      adjusted: number[];
      removed: number[];
    };

/**
 * "Bought it" with the owner's plan follow-ups, in one transaction: the
 * buy (buyGarment), then the items to change to match (the garment's own
 * candidacies only; the owner's save, so not proposed), then the other
 * candidates to remove (wishlist items that are candidates of those
 * items only; anything else posted is ignored). The removed photos' bytes
 * go after the commit. `ownerId` is the requester: the caller refuses a
 * grantee asking for follow-ups.
 */
export async function buyCandidate(
  deps: WardrobeDeps,
  garmentId: number,
  ownerId: number,
  purchase: Purchase & { archiveReplaced: boolean },
  followUps: PlanFollowUps,
): Promise<CandidatePurchaseOutcome> {
  const { db, photos, logger } = deps;
  const outcome = await db.transaction(async (tx) => {
    // Read while the garment is still on the wishlist: its links are read
    // through onWishlist, and stop mattering once it is bought.
    const candidacies = await candidaciesOf(tx, ownerId, [garmentId]);
    const itemIds = candidacies.map((c) => c.itemId);
    const others = [...(await candidatesOfItems(tx, ownerId, itemIds)).values()]
      .flat()
      .map((candidate) => candidate.garmentId)
      .filter((id) => id !== garmentId);
    const bought = await buyGarment(tx, garmentId, ownerId, purchase);
    if (!bought.ok) return bought;

    const adjusted: number[] = [];
    const adjust = itemIds.filter((id) => followUps.adjustItems.includes(id));
    if (adjust.length > 0) {
      const piece = (await pieceOf(tx, garmentId, ownerId))!;
      const planIds = [...new Set(candidacies.map((c) => c.planId))];
      const items = await itemsOf(tx, planIds);
      // Only an item the garment does not match is changed: the page offers
      // nothing else, and a rewrite would accept a matching proposal unasked.
      const mismatched = items.filter(
        (i) =>
          adjust.includes(i.id) &&
          targetDifferences(toTarget(i), piece).length > 0,
      );
      for (const item of mismatched) {
        await updateItem(
          tx,
          item.id,
          item.planId,
          ownerId,
          fittedItem(item, piece),
          {
            proposed: false,
          },
        );
        adjusted.push(item.id);
      }
    }

    const removed: { id: number; fileName: string | null }[] = [];
    for (const id of new Set(followUps.removeCandidates)) {
      if (!others.includes(id)) continue;
      const fileName = await deleteGarment(tx, id, ownerId);
      if (fileName !== undefined) removed.push({ id, fileName });
    }
    return {
      ok: true as const,
      archivedReplaced: bought.archivedReplaced,
      adjusted,
      removed,
    };
  });
  if (!outcome.ok) return outcome;
  // Only after commit: an unlink cannot be rolled back.
  for (const { fileName } of outcome.removed) {
    if (fileName) await photos.deleteVariants(fileName);
  }
  if (outcome.adjusted.length > 0 || outcome.removed.length > 0) {
    logger.info(
      `Garment ${garmentId} bought for user ${ownerId}'s plans: items ${outcome.adjusted.join(', ') || 'none'} changed to match, candidates ${outcome.removed.map((r) => r.id).join(', ') || 'none'} removed from the wishlist`,
    );
  }
  return {
    ok: true,
    archivedReplaced: outcome.archivedReplaced,
    adjusted: outcome.adjusted,
    removed: outcome.removed.map((r) => r.id),
  };
}
