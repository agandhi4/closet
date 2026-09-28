/**
 * The order mail's vocabularies (#25; src/web/wardrobe/order-mail/, plan
 * docs/plans/2026-09-28-order-email-import.md), shared with the schema's
 * check constraints.
 */

/** What reading one forwarded email came to (`order_email.outcome`). */
export const ORDER_EMAIL_OUTCOMES = [
  // At least one product kept for the review list.
  'imported',
  // Trusted, but no link led to a product page (or every product was listed already).
  'no-products',
  // Not from one of the owner's addresses, or its authentication failed.
  'untrusted',
  // Its body did not fit the fetcher's cap for a JMAP answer.
  'too-large',
] as const;
export type OrderEmailOutcome = (typeof ORDER_EMAIL_OUTCOMES)[number];

/**
 * A review list item's state (`order_item.state`). A pending item moves
 * once: to `added` when its garment is saved, or to `dismissed`; nothing
 * moves back (orderItemTransition).
 */
export const ORDER_ITEM_STATES = ['pending', 'added', 'dismissed'] as const;
export type OrderItemState = (typeof ORDER_ITEM_STATES)[number];

export type OrderItemEvent = 'add' | 'dismiss';

/** The state `event` moves a `from` item to; undefined when it may not. */
export function orderItemTransition(
  from: OrderItemState,
  event: OrderItemEvent,
): OrderItemState | undefined {
  if (from !== 'pending') return undefined;
  return event === 'add' ? 'added' : 'dismissed';
}
