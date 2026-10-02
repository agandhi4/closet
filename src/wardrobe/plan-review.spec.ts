import { describe, expect, it } from 'vitest';
import {
  type OwnerNoteEffect,
  PLAN_ITEM_REVIEW_EVENTS,
  PLAN_ITEM_REVIEWS,
  type PlanItemReview,
  type PlanItemReviewEvent,
  planItemReviewTransition,
} from './plan-review';

/** Every edge the machine allows, as (from, event, to, note). */
const ALLOWED: [
  PlanItemReview,
  PlanItemReviewEvent,
  PlanItemReview,
  OwnerNoteEffect,
][] = [
  ['proposed', 'accept', 'accepted', 'clear'],
  ['revise', 'accept', 'accepted', 'clear'],
  ['proposed', 'change', 'revise', 'write'],
  ['accepted', 'change', 'revise', 'write'],
  ['proposed', 'decline', 'declined', 'write'],
  ['revise', 'decline', 'declined', 'write'],
  ['revise', 'repropose', 'proposed', 'keep'],
  ['accepted', 'repropose', 'proposed', 'keep'],
  ['declined', 'reconsider', 'proposed', 'clear'],
];

const allowed = (review: PlanItemReview, event: PlanItemReviewEvent) =>
  ALLOWED.some(([from, on]) => from === review && on === event);

/** Every (review, event) pair the machine refuses. */
const REFUSED = PLAN_ITEM_REVIEWS.flatMap((review) =>
  PLAN_ITEM_REVIEW_EVENTS.filter((event) => !allowed(review, event)).map(
    (event) => [review, event] as const,
  ),
);

describe('plan item review machine', () => {
  it.each(ALLOWED)('%s --%s--> %s (note: %s)', (from, event, to, note) => {
    expect(planItemReviewTransition(from, event)).toEqual({
      ok: true,
      from,
      to,
      note,
    });
  });

  it.each(REFUSED)('refuses %s on %s', (review, event) => {
    expect(planItemReviewTransition(review, event)).toEqual({
      ok: false,
      review,
    });
  });

  it('checks every pair: 4 reviews by 5 events', () => {
    expect(ALLOWED.length + REFUSED.length).toBe(20);
  });

  it('never moves an item to where it already is', () => {
    for (const review of PLAN_ITEM_REVIEWS) {
      for (const event of PLAN_ITEM_REVIEW_EVENTS) {
        const result = planItemReviewTransition(review, event);
        if (result.ok) expect(result.to).not.toBe(review);
      }
    }
  });

  it('lets only the owner bring a declined item back: the agent never re-proposes one', () => {
    expect(planItemReviewTransition('declined', 'repropose').ok).toBe(false);
    expect(
      PLAN_ITEM_REVIEW_EVENTS.filter(
        (event) => planItemReviewTransition('declined', event).ok,
      ),
    ).toEqual(['reconsider']);
  });
});
