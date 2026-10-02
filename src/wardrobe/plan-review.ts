/**
 * Where a plan item is in the owner's review of their agent's work (#278,
 * epic #268). Stored as plan_item.review (a check constraint lists
 * PLAN_ITEM_REVIEWS; another refuses `revise` without the owner's note),
 * written at insert with an entry review and changed afterwards only by
 * reviewItems and updateItem (src/web/plans/queries.ts), which hold the
 * owner lock, ask planItemReviewTransition and write what it answers. Pure.
 *
 *   event        from                 to         owner's note
 *   accept       proposed, revise     accepted   cleared
 *   change       proposed, accepted   revise     written (required)
 *   decline      proposed, revise     declined   written (optional)
 *   repropose    revise, accepted     proposed   kept
 *   reconsider   declined             proposed   cleared
 *
 * - proposed: the owner's agent wrote it (propose_plan_item, or changed it:
 *   update_plan_item) and the owner has not decided. Not matched.
 * - accepted: part of the plan. The only review matching, the gap groups,
 *   the shopping list and comparing plans read.
 * - revise: the owner asked for a change ("Change this", their note
 *   required): waiting on the agent. Not matched.
 * - declined: "Don't buy" (a note optional). Kept, not deleted, so the
 *   agent sees it and never proposes it again. Not matched.
 *
 * Who moves what:
 * - accept (the owner: Accept, a candidate or Keep in the review, saving
 *   the item form): proposed or revise. Revise too, because the owner may
 *   make the change themselves in the form, or take the item as it was.
 * - change (the owner): proposed or accepted.
 * - decline (the owner): proposed or revise. An accepted item the owner no
 *   longer wants is deleted (the item form's Delete); there is nothing to
 *   tell the agent about something it never wrote.
 * - repropose (the agent's update_plan_item): revise or accepted. An agent
 *   editing its own still-proposed item is a content edit, not a move.
 * - reconsider (the owner): declined, back to proposed for the next review.
 *
 * Refused on purpose: every self-move (events name the move, so a stale
 * page or a double tap cannot apply one twice) and anything the agent
 * would do to a declined item.
 */

export const PLAN_ITEM_REVIEWS = [
  'proposed',
  'accepted',
  'revise',
  'declined',
] as const;
export type PlanItemReview = (typeof PLAN_ITEM_REVIEWS)[number];

/** Where a new item may start: the agent's proposal, or the owner's own. */
export type EntryReview = Extract<PlanItemReview, 'proposed' | 'accepted'>;

export const PLAN_ITEM_REVIEW_EVENTS = [
  'accept',
  'change',
  'decline',
  'repropose',
  'reconsider',
] as const;
export type PlanItemReviewEvent = (typeof PLAN_ITEM_REVIEW_EVENTS)[number];

/** What a move does to the owner's note. */
export type OwnerNoteEffect = 'write' | 'keep' | 'clear';

/** Each event's edges, the review it leads to, and what it does to the owner's note. */
const EDGES: Record<
  PlanItemReviewEvent,
  {
    from: readonly PlanItemReview[];
    to: PlanItemReview;
    note: OwnerNoteEffect;
  }
> = {
  accept: { from: ['proposed', 'revise'], to: 'accepted', note: 'clear' },
  change: { from: ['proposed', 'accepted'], to: 'revise', note: 'write' },
  decline: { from: ['proposed', 'revise'], to: 'declined', note: 'write' },
  // The note stays, so the owner reviewing the revision sees what they asked.
  repropose: { from: ['revise', 'accepted'], to: 'proposed', note: 'keep' },
  reconsider: { from: ['declined'], to: 'proposed', note: 'clear' },
};

export type PlanItemReviewTransition =
  | {
      ok: true;
      from: PlanItemReview;
      to: PlanItemReview;
      note: OwnerNoteEffect;
    }
  /** The review does not take the event; `review` is where it stays. */
  | { ok: false; review: PlanItemReview };

/** The review after `event`, or a refusal. */
export function planItemReviewTransition(
  review: PlanItemReview,
  event: PlanItemReviewEvent,
): PlanItemReviewTransition {
  const edge = EDGES[event];
  return edge.from.includes(review)
    ? { ok: true, from: review, to: edge.to, note: edge.note }
    : { ok: false, review };
}

/** Only accepted items are part of the plan: matching, gaps, shopping, compare. */
export function isAccepted(review: PlanItemReview): boolean {
  return review === 'accepted';
}
