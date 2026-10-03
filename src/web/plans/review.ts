import type { Static } from '@sinclair/typebox';
import type { Db, Queryable } from '../../db/client';
import { OUTFIT_ORDER } from '../../wardrobe/generator';
import type { PlanItemReviewEvent } from '../../wardrobe/plan-review';
import { categoryRole } from '../../wardrobe/properties';
import { type BudgetFit, rankCandidates } from '../../wardrobe/shopping';
import { ownerTransaction } from '../auth/queries';
import type { StoredPhoto } from '../files/image-variant';
import { deleteGarment } from '../wardrobe/queries';
import type { WardrobeDeps } from '../wardrobe/writes';
import {
  type CandidateGarment,
  candidaciesOf,
  candidatesOfItems,
  candidatesOfPlan,
  changeCandidates,
} from './candidates';
import { byPriority } from './gaps';
import {
  groupLooks,
  type LookGroups,
  type LookMoves,
  looksOfPlan,
  reactToLooks,
} from './looks';
import {
  findPlan,
  itemsOf,
  type PlanDetail,
  type PlanItemRow,
  reviewItems,
  setActivePlan,
} from './queries';
import { type RejectedCandidate, recordRejections } from './rejections';
import { type ListedCandidate, listedCandidate } from './shopping';
import {
  LOOK_PICKS,
  type LookPick,
  lookReactionName,
  type ReviewBody,
} from './validation';

/**
 * The plan review (#271, #278, epic #268): what an agent proposed, reviewed
 * the way Styling composes. One strip per proposed item (the shared snap
 * strip, src/web/strip/), its tiles Don't buy, Change this…, Keep and the
 * item's wishlist candidates; the centred tile is the pick. Under each
 * strip a note for the agent; on each candidate a "Not this one" box with
 * an optional reason. One post, "Accept these", decides every item the
 * page showed, in one owner transaction through the plans' own writers:
 *
 * - A candidate or Keep accepts the item; Don't buy declines it (its note
 *   optional) and Change this sends it back to the agent (its note
 *   required: a blank one is the page again, 400, with every pick kept).
 *   Both are review moves (reviewItems, src/wardrobe/plan-review.ts): the
 *   row stays, so the agent sees why. Only items in `shown` that are still
 *   proposed are touched: one proposed after the page was drawn is left
 *   for the next review, one decided meanwhile (a second post, the item
 *   form) is not decided again.
 * - "Not this one" records the product and the reason (plan_item_rejection,
 *   rejections.ts) and lets the candidate go, ticked box or not.
 * - With "Remove the products I didn't pick" ticked (it starts unticked),
 *   the unpicked candidates of a picked item and every candidate of a
 *   declined one are let go too.
 * - What is let go is judged only among the candidates the strip offered
 *   (each strip posts the candidates it drew, so one linked after the page
 *   was drawn is never judged by a choice made without it) that are still
 *   the item's. One is deleted from the wishlist (deleteGarment,
 *   'wishlist') only when every plan item it stands for (any plan, any
 *   review: candidaciesOf) is one of this post that lets it go, and no item
 *   here picked it; one bought meanwhile is kept (the delete judges the
 *   status under the row lock), and logged. One kept because it stands for
 *   something else is unlinked from each item here that let it go
 *   (changeCandidates), so a rejected product leaves the item and frees its
 *   place under the cap.
 * - A changed item lets nothing go but what was rejected: the agent sees
 *   what it offered.
 * - With "Make this my plan" (an inactive plan only), setActivePlan.
 * - The looks (#291): one strip of the plan's loved and proposed looks,
 *   each tile with Love it, Change this… (its note required, as an item's)
 *   and Not for me. Only looks the strip drew (`look`) are touched, each
 *   through reactToLooks (looks.ts, src/wardrobe/look-reaction.ts), so a
 *   look the agent added after the page was drawn waits for the next
 *   review, one left alone keeps its reaction, and one that moved meanwhile
 *   takes only what the machine allows from where it is. Nothing a look
 *   does deletes or unlinks anything.
 *
 * The removed photos' bytes go after the commit (the photo contract), as
 * "Bought it"'s do (purchase.ts).
 */

/** A tile's choice, as the strip's hidden input posts it (`pickValue`). */
export type ReviewPick =
  | { kind: 'decline' }
  | { kind: 'change' }
  | { kind: 'keep' }
  | { kind: 'candidate'; garmentId: number };

/** An item's posted choice, and what else its strip posted with it. */
export interface ReviewChoice {
  pick: ReviewPick;
  /** The candidates its strip offered, the only ones the post can let go. */
  offered: number[];
  /** The note for the agent, trimmed; null when blank. */
  note: string | null;
  /** The candidates ticked "Not this one", with each reason (null: none). */
  rejected: Map<number, string | null>;
}

/** Why a post the page could have sent is still refused, per item or look: the page again, 400. */
export type ReviewError = 'note-required';

/** A look's posted reaction (none: left as it is) and the note with it. */
export interface LookChoice {
  pick: LookPick | null;
  /** The note for the agent, trimmed; null when blank. */
  note: string | null;
}

/** An item's strip: the item and its candidates, the likeliest first. */
export interface ReviewStrip {
  item: PlanItemRow;
  candidates: { candidate: ListedCandidate; budget: BudgetFit }[];
}

/** The review page's model: the proposals' strips, and what waits apart. */
export interface PlanReview {
  strips: ReviewStrip[];
  /** Sent back to the agent with the owner's note ("Change this"). */
  revise: PlanItemRow[];
  /** "Don't buy": kept so the agent never proposes them again. */
  declined: PlanItemRow[];
  /** The plan's looks (#291): the strip's, and those waiting apart. */
  looks: LookGroups;
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
 * (rankCandidates), the items sent back or declined, and the plan's looks
 * (groupLooks). Three statements: the items, the candidates, the looks.
 */
export async function planReview(
  db: Db,
  plan: PlanDetail,
  ownerId: number,
): Promise<PlanReview> {
  const [items, candidates, looks] = await Promise.all([
    itemsOf(db, [plan.id]),
    candidatesOfPlan(db, ownerId, plan.id),
    looksOfPlan(db, ownerId, plan.id),
  ]);
  const inReview = (review: PlanItemRow['review']) =>
    items.filter((item) => item.review === review).sort(reviewOrder);
  return {
    strips: inReview('proposed').map((item) => ({
      item,
      candidates: rankCandidates(
        item,
        (candidates.get(item.id) ?? []).map((candidate) =>
          listedCandidate(item, candidate),
        ),
      ),
    })),
    revise: inReview('revise'),
    declined: inReview('declined'),
    looks: groupLooks(looks),
  };
}

/** The pick a strip starts on: its best candidate, else Keep (on every strip). */
export function defaultPick(strip: ReviewStrip): ReviewPick {
  const [best] = strip.candidates;
  return best
    ? { kind: 'candidate', garmentId: best.candidate.garmentId }
    : { kind: 'keep' };
}

/** A pick as a tile's `data-snap-value`: `12:decline`, `12:change`, `12:keep`, `12:345`. */
export function pickValue(itemId: number, pick: ReviewPick): string {
  return `${itemId}:${pick.kind === 'candidate' ? pick.garmentId : pick.kind}`;
}

/** A candidate of a strip, as its hidden `offered` input and its "Not this one" box post it: `12:345`. */
export function offeredValue(itemId: number, garmentId: number): string {
  return `${itemId}:${garmentId}`;
}

/** What one "Accept these" posts (ReviewBody's arrays, each optional one empty when absent). */
export interface ReviewPost {
  shown: readonly number[];
  picks: readonly string[];
  offered: readonly string[];
  /** One per shown strip, in `shown`'s order (each strip's textarea). */
  notes: readonly string[];
  rejects: readonly string[];
  /** One per offered candidate, in `offered`'s order (each tile's reason). */
  reasons: readonly string[];
  /** The looks the strip drew (#291). */
  looks: readonly number[];
  /** One per look, in `looks`' order (each tile's note). */
  lookNotes: readonly string[];
  /** One per look, in `looks`' order: its radios' value, absent when none was tapped. */
  lookPicks: readonly (LookPick | '' | undefined)[];
}

/** "Accept these"'s body as readReview takes it: each absent list empty, each look's radios by its id. */
export function reviewPostOf(body: Static<typeof ReviewBody>): ReviewPost {
  const looks = body.look ?? [];
  return {
    shown: body.shown ?? [],
    picks: body.pick ?? [],
    offered: body.offered ?? [],
    notes: body.note ?? [],
    rejects: body.reject ?? [],
    reasons: body.rejectReason ?? [],
    looks,
    lookNotes: body.lookNote ?? [],
    lookPicks: looks.map((lookId) => body[lookReactionName(lookId)]),
  };
}

export type ReadReview =
  /** Not a post the page could have sent: it is drawn again as it stands now. */
  | { ok: false; reason: 'mismatch' }
  /**
   * The choices by item id and by look id; `errors` (by item) or
   * `lookErrors` (by look) non-empty refuses the post, 400, kept as posted.
   */
  | {
      ok: true;
      choices: Map<number, ReviewChoice>;
      errors: Map<number, ReviewError>;
      looks: Map<number, LookChoice>;
      lookErrors: Map<number, ReviewError>;
    };

/** A posted note or reason, trimmed; null when blank. */
const text = (value: string | undefined): string | null =>
  value?.trim() || null;

/**
 * The posted choices by item id, every shown item with exactly one pick,
 * or a mismatch when the post is not one the page could have sent (a pick,
 * an offered candidate or a rejection for an item not shown, a rejection
 * of a candidate its strip did not offer, two picks for one, a shown item
 * without one, notes or reasons that do not pair with their strips and
 * tiles, a look drawn twice, look notes that do not pair with the looks):
 * the route re-renders the page 400. Then each item's and each look's own
 * errors: Change this without a note. A garment
 * id is only compared with the item's candidates, never queried, so one
 * past the column's range is simply not one of them.
 */
export function readReview(post: ReviewPost): ReadReview {
  const choices = readChoices(post);
  const looks = readLooks(post);
  if (!choices || !looks) return { ok: false, reason: 'mismatch' };
  const errors = new Map<number, ReviewError>();
  for (const [itemId, choice] of choices) {
    const error = choiceError(choice);
    if (error) errors.set(itemId, error);
  }
  const lookErrors = new Map<number, ReviewError>();
  for (const [lookId, choice] of looks) {
    if (choice.pick === 'change' && choice.note === null) {
      lookErrors.set(lookId, 'note-required');
    }
  }
  return { ok: true, choices, errors, looks, lookErrors };
}

/** readReview's look choices, or undefined for a post the page could not have sent. */
function readLooks(post: ReviewPost): Map<number, LookChoice> | undefined {
  if (
    post.lookNotes.length !== post.looks.length ||
    new Set(post.looks).size !== post.looks.length
  ) {
    return undefined;
  }
  return new Map(
    post.looks.map((lookId, index) => [
      lookId,
      {
        pick: post.lookPicks[index] || null,
        note: text(post.lookNotes[index]),
      },
    ]),
  );
}

/** A pick as its tile posts it (`pickValue`'s part after the item). */
function readPick(choice: string): ReviewPick {
  return choice === 'decline' || choice === 'change' || choice === 'keep'
    ? { kind: choice }
    : { kind: 'candidate', garmentId: Number(choice) };
}

/** `<item>:<garment>` as numbers. */
function pair(value: string): [number, number] {
  const [itemId, garmentId] = value.split(':').map(Number);
  return [itemId, garmentId];
}

/** readReview's choices, or undefined for a post the page could not have sent. */
function readChoices(post: ReviewPost): Map<number, ReviewChoice> | undefined {
  const { shown } = post;
  const paired =
    (post.notes.length === 0 || post.notes.length === shown.length) &&
    (post.reasons.length === 0 || post.reasons.length === post.offered.length);
  if (!paired) return undefined;
  const choices = new Map<number, ReviewChoice>();
  for (const value of post.picks) {
    const [item, choice] = value.split(':');
    const itemId = Number(item);
    if (choices.has(itemId) || !shown.includes(itemId)) return undefined;
    choices.set(itemId, {
      pick: readPick(choice),
      offered: [],
      note: text(post.notes[shown.indexOf(itemId)]),
      rejected: new Map(),
    });
  }
  if (new Set(shown).size !== choices.size) return undefined;
  const reasons = new Map<string, string | null>();
  for (const [index, value] of post.offered.entries()) {
    const [itemId, garmentId] = pair(value);
    const choice = choices.get(itemId);
    if (!choice) return undefined;
    choice.offered.push(garmentId);
    reasons.set(value, text(post.reasons[index]));
  }
  for (const value of post.rejects) {
    const [itemId, garmentId] = pair(value);
    const choice = choices.get(itemId);
    if (!choice?.offered.includes(garmentId)) return undefined;
    choice.rejected.set(garmentId, reasons.get(value) ?? null);
    // A rejected pick reads as Keep: the item is accepted without a product.
    if (
      choice.pick.kind === 'candidate' &&
      choice.pick.garmentId === garmentId
    ) {
      choice.pick = { kind: 'keep' };
    }
  }
  return choices;
}

/** Why an item's choice, one the page could send, is still refused. */
function choiceError({ pick, note }: ReviewChoice): ReviewError | undefined {
  if (pick.kind === 'change' && note === null) return 'note-required';
  return undefined;
}

export interface ReviewDecision {
  shown: number[];
  choices: Map<number, ReviewChoice>;
  /** The looks the strip drew, each with its reaction (#291). */
  looks: Map<number, LookChoice>;
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
      changed: number[];
      declined: number[];
      /** Shown but no longer proposed: decided already, left as they are. */
      decided: number[];
      /** How many candidates were turned down ("Not this one"). */
      rejected: number;
      removed: number[];
      /** To remove, but no longer on the wishlist (bought meanwhile). */
      kept: number[];
      activated: boolean;
      /** The looks moved by each reaction, and those whose reaction refused it. */
      looks: Record<LookPick, number[]> & { refused: LookMoves['refused'] };
    };

/** The machine's event each pick makes. */
function eventOf(pick: ReviewPick): PlanItemReviewEvent {
  switch (pick.kind) {
    case 'decline':
      return 'decline';
    case 'change':
      return 'change';
    case 'keep':
    case 'candidate':
      return 'accept';
  }
}

/**
 * "Accept these": `decision` on `ownerId`'s plan `planId`, in one owner
 * transaction (the rule in full at the top of this file). Every read is
 * under the owner lock, which every plan, item and candidate writer takes,
 * so the candidacies a removal is judged by cannot change before the
 * deletes; a wishlist purchase does not take it, which the deletes'
 * status guard covers. The caller has refused a post with errors
 * (readReview).
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
      const isOpen = (id: number) => items.get(id)!.review === 'proposed';
      const open = decision.shown.filter(isOpen);
      const decided = decision.shown.filter((id) => !isOpen(id));
      const release = await releasedCandidates(
        tx,
        ownerId,
        open,
        decision.choices,
        decision.removeUnpicked,
      );

      const moved: Record<PlanItemReviewEvent, number[]> = {
        accept: [],
        change: [],
        decline: [],
        repropose: [],
        reconsider: [],
      };
      for (const event of ['accept', 'change', 'decline'] as const) {
        const moves = open
          .filter((id) => eventOf(decision.choices.get(id)!.pick) === event)
          .map((itemId) => ({
            itemId,
            note: decision.choices.get(itemId)!.note,
          }));
        moved[event] = (
          await reviewItems(tx, ownerId, planId, event, moves)
        ).moved;
      }
      await recordRejections(tx, release.rejected);
      for (const set of release.unlink) {
        await changeCandidates(tx, ownerId, { remove: set });
      }
      const removed: { id: number; photo: StoredPhoto | null }[] = [];
      const kept: number[] = [];
      for (const id of release.deletable) {
        const deleted = await deleteGarment(tx, id, ownerId, 'wishlist');
        if (deleted === undefined) kept.push(id);
        else removed.push({ id, photo: deleted.photo });
      }
      const looks = await reactToLooksOfPost(
        tx,
        ownerId,
        planId,
        decision.looks,
      );
      const activated =
        decision.activate &&
        !plan.active &&
        (await setActivePlan(tx, planId, ownerId));
      return {
        ok: true as const,
        accepted: moved.accept,
        changed: moved.change,
        declined: moved.decline,
        decided,
        rejected: release.rejected.length,
        removed,
        kept,
        activated,
        looks,
      };
    },
  );
  if (!outcome.ok) return outcome;
  // Only after commit: an unlink cannot be rolled back.
  for (const { photo } of outcome.removed) {
    if (photo) await photos.deleteVariants(photo);
  }
  const removed = outcome.removed.map((r) => r.id);
  const list = (ids: number[]) => ids.join(', ') || 'none';
  logger.info(
    `Plan ${planId} reviewed by user ${ownerId}: accepted ${list(outcome.accepted)}, changes asked for ${list(outcome.changed)}, declined ${list(outcome.declined)}, ${outcome.rejected} candidates turned down, candidates ${list(removed)} removed from the wishlist${outcome.activated ? ', made active' : ''}`,
  );
  if (outcome.decided.length > 0) {
    logger.info(
      `Plan ${planId} review by user ${ownerId}: items ${outcome.decided.join(', ')} left as they are, no longer proposed`,
    );
  }
  const { looks } = outcome;
  if (decision.looks.size > 0) {
    logger.info(
      `Plan ${planId} review by user ${ownerId}: looks loved ${list(looks.love)}, changes asked for ${list(looks.change)}, declined ${list(looks.decline)}`,
    );
  }
  if (looks.refused.length > 0) {
    logger.info(
      `Plan ${planId} review by user ${ownerId}: looks ${looks.refused.map((r) => `${r.lookId} (${r.reaction})`).join(', ')} not moved (already moved or not this plan's)`,
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
 * The post's look reactions, one reactToLooks per reaction that some look
 * chose (nested in the review's owner transaction): only `looks`, the ones
 * the strip drew, are named. A look that is no look of the plan any more
 * is in neither list, and so left out.
 */
async function reactToLooksOfPost(
  tx: Queryable,
  ownerId: number,
  planId: number,
  looks: ReadonlyMap<number, LookChoice>,
): Promise<Record<LookPick, number[]> & { refused: LookMoves['refused'] }> {
  const result = {
    love: [] as number[],
    change: [] as number[],
    decline: [] as number[],
    refused: [] as LookMoves['refused'],
  };
  for (const pick of LOOK_PICKS) {
    const moves = [...looks]
      .filter(([, choice]) => choice.pick === pick)
      .map(([lookId, choice]) => ({ lookId, note: choice.note }));
    const { moved, refused } = await reactToLooks(
      tx,
      ownerId,
      planId,
      pick,
      moves,
    );
    result[pick] = moved;
    result.refused.push(...refused);
  }
  return result;
}

/**
 * What the post lets go among the candidates the `open` items' strips
 * offered that are still theirs: the rejections to record, the garments to
 * delete from the wishlist (id order, as every multi-row garment locker
 * takes them), and the links to drop of those kept because they stand for
 * another item. An item lets go of its rejected candidates; with
 * `removeUnpicked`, a picked item also of its unpicked ones and a declined
 * item of all of them. Keep and Change this let go of nothing else, nor
 * does a pick that is no current candidate (one bought or unlinked since
 * the page was drawn): which to remove was not shown against it. A garment
 * is deletable when every plan item it is a candidate of is one of these
 * that lets it go and no item here picked it. Reads nothing when nothing
 * can be let go.
 */
async function releasedCandidates(
  tx: Queryable,
  ownerId: number,
  open: readonly number[],
  choices: ReadonlyMap<number, ReviewChoice>,
  removeUnpicked: boolean,
): Promise<{
  rejected: RejectedCandidate[];
  deletable: number[];
  unlink: { itemIds: number[]; garmentIds: number[] }[];
}> {
  const judged = open.filter(
    (id) => removeUnpicked || choices.get(id)!.rejected.size > 0,
  );
  if (judged.length === 0) return { rejected: [], deletable: [], unlink: [] };
  const candidates = await candidatesOfItems(tx, ownerId, judged);
  const picked = new Set<number>();
  const rejected: RejectedCandidate[] = [];
  // Each garment let go, with the items that let it go.
  const releasedBy = new Map<number, Set<number>>();
  const letGo = (garmentId: number, itemId: number) =>
    releasedBy.set(
      garmentId,
      (releasedBy.get(garmentId) ?? new Set()).add(itemId),
    );
  for (const itemId of judged) {
    const choice = choices.get(itemId)!;
    const held: CandidateGarment[] = (candidates.get(itemId) ?? []).filter(
      (candidate) => choice.offered.includes(candidate.garmentId),
    );
    const { pick } = choice;
    const pickHeld =
      pick.kind === 'candidate' &&
      held.some((candidate) => candidate.garmentId === pick.garmentId);
    if (pickHeld) picked.add(pick.garmentId);
    for (const candidate of held) {
      const reason = choice.rejected.get(candidate.garmentId);
      if (reason !== undefined) {
        rejected.push({ candidate, reason });
        letGo(candidate.garmentId, itemId);
      } else if (
        removeUnpicked &&
        (pick.kind === 'decline' ||
          (pickHeld && candidate.garmentId !== pick.garmentId))
      ) {
        letGo(candidate.garmentId, itemId);
      }
    }
  }
  const released = [...releasedBy.keys()];
  const links = await candidaciesOf(tx, ownerId, released);
  const deletable = released
    .filter(
      (garmentId) =>
        !picked.has(garmentId) &&
        links
          .filter((link) => link.garmentId === garmentId)
          .every((link) => releasedBy.get(garmentId)!.has(link.itemId)),
    )
    .sort((a, b) => a - b);
  // A kept one leaves every item here that let it go.
  const unlink = judged.flatMap((itemId) => {
    const garmentIds = [...releasedBy]
      .filter(
        ([garmentId, by]) => by.has(itemId) && !deletable.includes(garmentId),
      )
      .map(([garmentId]) => garmentId);
    return garmentIds.length > 0 ? [{ itemIds: [itemId], garmentIds }] : [];
  });
  return { rejected, deletable, unlink };
}
