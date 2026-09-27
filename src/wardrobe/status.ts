/**
 * Where a garment is in its life: wanted, owned, or owned once. Stored as
 * garment.status (a check constraint lists GARMENT_STATUSES), written at
 * insert with an entry status and changed afterwards only by
 * setGarmentStatus (src/web/wardrobe/status.ts), which locks the row, asks
 * garmentStatusTransition and writes what it answers. Pure; the plan's
 * section 11 (docs/plans/2026-09-26-wardrobe-features.md) and issue #18.
 *
 *              buy                 archive
 *   wishlist ───────▶ closet ◀──────────────▶ archived
 *                               restore
 *
 * - wishlist: a garment being considered (a product link, a price). Not
 *   owned, so no closet read shows it (inCloset): not the grid, the outfit
 *   builder, capsules, laundry or wears.
 * - closet: owned and in use; what every closet read shows.
 * - archived: owned once (given away, worn out). Its outfits, wears and
 *   capsule memberships stay as history; closet reads leave it out.
 *
 * Refused on purpose:
 * - wishlist -> archived. Deciding against a wishlist item deletes it
 *   (DELETE /wardrobe/:id): it has no wears or outfits to keep, and an
 *   archive of things never owned would read as a history of clothes worn.
 * - closet or archived -> wishlist. A garment that was owned has wears,
 *   outfits and a photo of the real thing; wanting another is a new
 *   wishlist item (clone, or "Find a replacement").
 * - Any status to itself. Events name the move ("Bought it", "Archive",
 *   "Restore"), not a target, so a stale page cannot flip a garment back
 *   the way the old archive toggle could.
 */

export const GARMENT_STATUSES = ['wishlist', 'closet', 'archived'] as const;
export type GarmentStatus = (typeof GARMENT_STATUSES)[number];

/** Where a new garment may start: the form's two destinations. */
export const ENTRY_STATUSES = ['closet', 'wishlist'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const GARMENT_STATUS_EVENTS = ['buy', 'archive', 'restore'] as const;
export type GarmentStatusEvent = (typeof GARMENT_STATUS_EVENTS)[number];

/** Each event's one edge: the status it applies to and the one it leads to. */
const EDGES: Record<
  GarmentStatusEvent,
  { from: GarmentStatus; to: GarmentStatus }
> = {
  buy: { from: 'wishlist', to: 'closet' },
  archive: { from: 'closet', to: 'archived' },
  restore: { from: 'archived', to: 'closet' },
};

export type GarmentStatusTransition =
  | { ok: true; from: GarmentStatus; to: GarmentStatus }
  /** The status does not take the event; `status` is where it stays. */
  | { ok: false; status: GarmentStatus };

/** The status after `event`, or a refusal. */
export function garmentStatusTransition(
  status: GarmentStatus,
  event: GarmentStatusEvent,
): GarmentStatusTransition {
  const edge = EDGES[event];
  return edge.from === status
    ? { ok: true, from: status, to: edge.to }
    : { ok: false, status };
}

/**
 * A clone's entry status: a copy of something owned lands in the closet
 * (as clones always have, archived sources included); a copy of a wishlist
 * item lands on the requester's wishlist ("I want that too", a gift idea
 * from a shared wishlist).
 */
export function statusOfClone(source: GarmentStatus): EntryStatus {
  return source === 'wishlist' ? 'wishlist' : 'closet';
}
