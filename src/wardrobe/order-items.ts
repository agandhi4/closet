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
 * Where reading one email stands (`order_email.status`, #693): `decided`
 * (it has an outcome), `failed` (read again by the next poll, which starts
 * the watermark at it), `parked` (given up after ORDER_MAIL_ATTEMPTS, or no
 * longer in the inbox: never read again, and the watermark passes it).
 */
export const ORDER_EMAIL_STATUSES = ['decided', 'failed', 'parked'] as const;
export type OrderEmailStatus = (typeof ORDER_EMAIL_STATUSES)[number];

/**
 * Whose fault a failed read was: the email's own (its body answer's shape,
 * a 4xx for it, a product the columns refuse) spends one of its attempts;
 * the mailbox's (JMAP unreachable, refusing the token, a 5xx, a method
 * error; the database out of reach or timing out counts here too) fails the
 * run and spends none, so an outage never parks the inbox.
 */
export type OrderEmailFailureScope = 'email' | 'mailbox';

/**
 * An email failing this many reads is parked. Link fetches that fail are
 * skipped before this, so what is left is near-deterministic (the page's
 * data, a bug of ours); the rare transient one gets two more polls.
 */
export const ORDER_MAIL_ATTEMPTS = 3;
/**
 * This many mailbox-level failures in a row while one email was being read
 * count as one of its attempts: the backstop for a mailbox error that is
 * really that email's (a body JMAP fails on every time).
 */
export const ORDER_MAIL_MAILBOX_STRIKES = 3;

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
