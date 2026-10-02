import type { Db, Queryable } from '../../db/client';
import { OUTFIT_ORDER } from '../../wardrobe/generator';
import { categoryRole } from '../../wardrobe/properties';
import { type BudgetFit, rankCandidates } from '../../wardrobe/shopping';
import { ownerTransaction } from '../auth/queries';
import type { StoredPhoto } from '../files/image-variant';
import { deleteGarment } from '../wardrobe/queries';
import type { WardrobeDeps } from '../wardrobe/writes';
import {
  candidaciesOf,
  candidatesOfItems,
  candidatesOfPlan,
  changeCandidates,
} from './candidates';
import { byPriority } from './gaps';
import {
  acceptItems,
  deleteItems,
  findPlan,
  itemsOf,
  type PlanDetail,
  type PlanItemRow,
  setActivePlan,
} from './queries';
import { type ListedCandidate, listedCandidate } from './shopping';

/**
 * The plan review (#271, epic #268): what an agent proposed, reviewed the
 * way Styling composes. One strip per proposed item (the shared snap
 * strip, src/web/strip/), its tiles Skip, Keep and the item's wishlist
 * candidates; the centred tile is the pick. One post, "Accept these",
 * decides every item the page showed, in one owner transaction through the
 * plans' own writers:
 *
 * - A candidate or Keep accepts the item (acceptItems); Skip dismisses it
 *   (deleteItems). Only items in `shown` that are still proposed are
 *   touched: one proposed after the page was drawn is left for the next
 *   review, one decided meanwhile (a second post, the item form) is not
 *   decided again.
 * - With "Remove the products I didn't pick" ticked (it starts unticked),
 *   the unpicked candidates of a picked item and every candidate of a
 *   skipped one are deleted from the wishlist (deleteGarment, 'wishlist'),
 *   but only one its strip offered (each strip posts the candidates it
 *   drew, so one linked after the page was drawn is never judged by a
 *   choice made without it), that stands for no other plan item of the
 *   owner's (any plan, accepted items and the active plan's included:
 *   candidaciesOf) and is picked for no item of this post; one bought meanwhile is kept (the delete judges
 *   the status under the row lock), and logged. One kept because it stands
 *   for something else is unlinked from the item the owner picked against
 *   (changeCandidates), so that item's candidates are its pick.
 * - With "Make this my plan" (an inactive plan only), setActivePlan.
 *
 * The removed photos' bytes go after the commit (the photo contract), as
 * "Bought it"'s do (purchase.ts).
 */

/** A tile's choice, as the strip's hidden input posts it (`pickValue`). */
export type ReviewPick =
  | { kind: 'skip' }
  | { kind: 'keep' }
  | { kind: 'candidate'; garmentId: number };

/**
 * An item's posted choice: the pick, and the candidates its strip offered,
 * the only ones the pick can let go.
 */
export interface ReviewChoice {
  pick: ReviewPick;
  offered: number[];
}

/** An item's strip: the item and its candidates, the likeliest first. */
export interface ReviewStrip {
  item: PlanItemRow;
  candidates: { candidate: ListedCandidate; budget: BudgetFit }[];
}

/** The category's role in OUTFIT_ORDER; a custom category plays none, so after every role. */
function roleRank(category: string): number {
  const rank = OUTFIT_ORDER.indexOf(categoryRole(category));
  return rank === -1 ? OUTFIT_ORDER.length : rank;
}

/** Top to toe by the category's role, then the gap view's order (byPriority). */
function reviewOrder(a: PlanItemRow, b: PlanItemRow): number {
  return roleRank(a.category) - roleRank(b.category) || byPriority(a, b);
}

/**
 * The review page's strips: `plan`'s proposed items (the caller found it
 * the owner's) with their candidates in the shopping list's order
 * (rankCandidates). Two statements: the items, the candidates.
 */
export async function planReview(
  db: Db,
  plan: PlanDetail,
  ownerId: number,
): Promise<ReviewStrip[]> {
  const [items, candidates] = await Promise.all([
    itemsOf(db, [plan.id]),
    candidatesOfPlan(db, ownerId, plan.id),
  ]);
  return items
    .filter((item) => item.proposed)
    .sort(reviewOrder)
    .map((item) => ({
      item,
      candidates: rankCandidates(
        item,
        (candidates.get(item.id) ?? []).map((candidate) =>
          listedCandidate(item, candidate),
        ),
      ),
    }));
}

/** The pick a strip starts on: its best candidate, else Keep (on every strip). */
export function defaultPick(strip: ReviewStrip): ReviewPick {
  const [best] = strip.candidates;
  return best
    ? { kind: 'candidate', garmentId: best.candidate.garmentId }
    : { kind: 'keep' };
}

/** A pick as a tile's `data-snap-value`: `12:skip`, `12:keep`, `12:345`. */
export function pickValue(itemId: number, pick: ReviewPick): string {
  return `${itemId}:${pick.kind === 'candidate' ? pick.garmentId : pick.kind}`;
}

/** A candidate a strip offered, as its hidden input posts it: `12:345`. */
export function offeredValue(itemId: number, garmentId: number): string {
  return `${itemId}:${garmentId}`;
}

/**
 * The posted choices by item id, every shown item with exactly one pick, or
 * undefined when the post is not one the page could have sent (a pick or
 * an offered candidate for an item not shown, two picks for one, a shown
 * item without one): the route re-renders the page 400. Its keys are the
 * shown items, each once. A garment id is only compared with the item's
 * candidates, never queried, so one past the column's range is simply not
 * one of them.
 */
export function readPicks(
  shown: readonly number[],
  picks: readonly string[],
  offered: readonly string[],
): Map<number, ReviewChoice> | undefined {
  const choices = new Map<number, ReviewChoice>();
  for (const value of picks) {
    const [item, choice] = value.split(':');
    const itemId = Number(item);
    if (choices.has(itemId) || !shown.includes(itemId)) return undefined;
    const pick: ReviewPick =
      choice === 'skip' || choice === 'keep'
        ? { kind: choice }
        : { kind: 'candidate', garmentId: Number(choice) };
    choices.set(itemId, { pick, offered: [] });
  }
  if (new Set(shown).size !== choices.size) return undefined;
  for (const value of offered) {
    const [itemId, garmentId] = value.split(':').map(Number);
    const choice = choices.get(itemId);
    if (!choice) return undefined;
    choice.offered.push(garmentId);
  }
  return choices;
}

export interface ReviewDecision {
  shown: number[];
  choices: Map<number, ReviewChoice>;
  removeUnpicked: boolean;
  activate: boolean;
}

export type ReviewOutcome =
  | { ok: false; reason: 'not-found' }
  /** Shown ids that are no item of the plan (any more): a 400. */
  | { ok: false; reason: 'unknown-items'; itemIds: number[] }
  | {
      ok: true;
      accepted: number[];
      dismissed: number[];
      /** Shown but no longer proposed: decided already, left as they are. */
      decided: number[];
      removed: number[];
      /** To remove, but no longer on the wishlist (bought meanwhile). */
      kept: number[];
      activated: boolean;
    };

/**
 * "Accept these": `decision` on `ownerId`'s plan `planId`, in one owner
 * transaction (the rule in full at the top of this file). Every read is
 * under the owner lock, which every plan, item and candidate writer takes,
 * so the candidacies a removal is judged by cannot change before the
 * deletes; a wishlist purchase does not take it, which the deletes'
 * status guard covers.
 */
export async function applyReview(
  deps: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  ownerId: number,
  planId: number,
  decision: ReviewDecision,
): Promise<ReviewOutcome> {
  const { db, photos, logger } = deps;
  const outcome = await ownerTransaction(
    db,
    ownerId,
    'applyReview',
    async (tx) => {
      const plan = await findPlan(tx, planId, ownerId);
      if (!plan) return { ok: false as const, reason: 'not-found' as const };
      const items = new Map(
        (await itemsOf(tx, [planId])).map((item) => [item.id, item]),
      );
      const unknown = decision.shown.filter((id) => !items.has(id));
      if (unknown.length > 0) {
        return {
          ok: false as const,
          reason: 'unknown-items' as const,
          itemIds: unknown,
        };
      }
      const open = decision.shown.filter((id) => items.get(id)!.proposed);
      const decided = decision.shown.filter((id) => !items.get(id)!.proposed);
      const removals = decision.removeUnpicked
        ? await unpickedCandidates(tx, ownerId, open, decision.choices)
        : { deletable: [], unlink: [] };

      const skipped = open.filter(
        (id) => decision.choices.get(id)!.pick.kind === 'skip',
      );
      const accepted = await acceptItems(
        tx,
        open.filter((id) => !skipped.includes(id)),
        planId,
        ownerId,
      );
      const dismissed = await deleteItems(tx, skipped, planId, ownerId);
      for (const set of removals.unlink) {
        await changeCandidates(tx, ownerId, { remove: set });
      }
      const removed: { id: number; photo: StoredPhoto | null }[] = [];
      const kept: number[] = [];
      for (const id of removals.deletable) {
        const deleted = await deleteGarment(tx, id, ownerId, 'wishlist');
        if (deleted === undefined) kept.push(id);
        else removed.push({ id, photo: deleted.photo });
      }
      const activated =
        decision.activate &&
        !plan.active &&
        (await setActivePlan(tx, planId, ownerId));
      return {
        ok: true as const,
        accepted,
        dismissed,
        decided,
        removed,
        kept,
        activated,
      };
    },
  );
  if (!outcome.ok) return outcome;
  // Only after commit: an unlink cannot be rolled back.
  for (const { photo } of outcome.removed) {
    if (photo) await photos.deleteVariants(photo);
  }
  const removed = outcome.removed.map((r) => r.id);
  logger.info(
    `Plan ${planId} reviewed by user ${ownerId}: accepted ${outcome.accepted.join(', ') || 'none'}, dismissed ${outcome.dismissed.join(', ') || 'none'}, candidates ${removed.join(', ') || 'none'} removed from the wishlist${outcome.activated ? ', made active' : ''}`,
  );
  if (outcome.decided.length > 0) {
    logger.info(
      `Plan ${planId} review by user ${ownerId}: items ${outcome.decided.join(', ')} left as they are, no longer proposed`,
    );
  }
  if (outcome.kept.length > 0) {
    logger.info(
      `Plan ${planId} review by user ${ownerId}: candidates ${outcome.kept.join(', ')} kept, no longer on the wishlist`,
    );
  }
  return { ...outcome, removed };
}

/**
 * What "Remove the products I didn't pick" takes, among the candidates the
 * `open` items' strips offered that are still theirs: the garments to
 * delete from the wishlist (id order, as every multi-row garment locker
 * takes them), and the links to drop of those kept because they stand for
 * another item. A garment is deletable when
 * every plan item it is a candidate of is one of these whose pick lets it
 * go (an unpicked candidate of a picked item, any candidate of a skipped
 * one) and no item here picked it. Keep lets nothing go, nor does a pick
 * that is not one of those (one bought or unlinked since the page was
 * drawn): which to remove was not shown against it.
 */
async function unpickedCandidates(
  tx: Queryable,
  ownerId: number,
  open: readonly number[],
  choices: ReadonlyMap<number, ReviewChoice>,
): Promise<{
  deletable: number[];
  unlink: { itemIds: number[]; garmentIds: number[] }[];
}> {
  const candidates = await candidatesOfItems(tx, ownerId, [...open]);
  const picked = new Set<number>();
  // Each unpicked garment, with the items whose pick lets it go.
  const releasedBy = new Map<number, Set<number>>();
  for (const itemId of open) {
    const { pick, offered } = choices.get(itemId)!;
    const held = (candidates.get(itemId) ?? [])
      .map((c) => c.garmentId)
      .filter((garmentId) => offered.includes(garmentId));
    if (pick.kind === 'keep') continue;
    if (pick.kind === 'candidate') {
      if (!held.includes(pick.garmentId)) continue;
      picked.add(pick.garmentId);
    }
    for (const garmentId of held) {
      if (pick.kind === 'candidate' && garmentId === pick.garmentId) continue;
      releasedBy.set(
        garmentId,
        (releasedBy.get(garmentId) ?? new Set()).add(itemId),
      );
    }
  }
  const unpicked = [...releasedBy.keys()].filter((id) => !picked.has(id));
  const links = await candidaciesOf(tx, ownerId, unpicked);
  const deletable = unpicked
    .filter((garmentId) =>
      links
        .filter((link) => link.garmentId === garmentId)
        .every((link) => releasedBy.get(garmentId)!.has(link.itemId)),
    )
    .sort((a, b) => a - b);
  // A kept one leaves the items picked against it; a skipped item's links
  // go with the item.
  const unlink = open.flatMap((itemId) => {
    if (choices.get(itemId)!.pick.kind !== 'candidate') return [];
    const garmentIds = [...releasedBy]
      .filter(
        ([garmentId, items]) =>
          items.has(itemId) && !deletable.includes(garmentId),
      )
      .map(([garmentId]) => garmentId);
    return garmentIds.length > 0 ? [{ itemIds: [itemId], garmentIds }] : [];
  });
  return { deletable, unlink };
}
