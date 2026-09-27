import { and, type Column, eq, ne, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment } from '../../db/schema';
import {
  type GarmentStatus,
  type GarmentStatusEvent,
  garmentStatusTransition,
} from '../../wardrobe/status';
import type { IsoDate } from '../calendar/calendar-date';

/**
 * garment.status in queries: the predicates every read uses, and the one
 * writer of a status change (the machine itself is pure,
 * src/wardrobe/status.ts). The status is written at insert (insertGarment,
 * an entry status) and changed only by setGarmentStatus below.
 */

/**
 * "In the closet": owned and in use. The one predicate for every closet
 * read, so a wishlist item or an archived garment never shows up where
 * clothes one can wear do: the grid (without "Show archived"), the outfit
 * builder's cycles, capsules' counts and pages, tagging mode, laundry and
 * the wash counts, availableGarment (src/web/wears/queries.ts), the MCP
 * tools' closet reads, the outfit generator (#9, through availableGarment),
 * insights (src/web/insights/queries.ts) and "Goes with my closet" (#18b:
 * closetGarments, src/web/gallery/queries.ts, with one wishlist item locked
 * beside it, never mixed in).
 *
 * `status` is the column to test: garment.status, or an alias's (the outfit
 * edit form's peers).
 */
export function inCloset(status: Column = garment.status): SQL {
  return eq(status, 'closet');
}

/** On the wishlist: the Wishlist tab, list_wishlist (MCP). */
export function onWishlist(): SQL {
  return eq(garment.status, 'wishlist');
}

/**
 * Owned now or once (the closet and the archive), never a wishlist item:
 * the grid's "Show archived", the filter modal's choices, what an outfit
 * slot, a capsule membership or a wash may name.
 */
export function ownedGarment(): SQL {
  return ne(garment.status, 'wishlist');
}

/** Which garments a list shows (GridFilters.scope). */
export type GarmentScope = 'closet' | 'owned' | 'wishlist';

export function inScope(scope: GarmentScope): SQL {
  switch (scope) {
    case 'closet':
      return inCloset();
    case 'owned':
      return ownedGarment();
    case 'wishlist':
      return onWishlist();
  }
}

/** What "Bought it" records with the move: the day and the price paid. */
export interface Purchase {
  acquiredOn: IsoDate | null;
  price: string | null;
}

/** A status change: the machine's event, and for a purchase what it records. */
export type StatusChange =
  | ({ event: 'buy' } & Purchase)
  | { event: Exclude<GarmentStatusEvent, 'buy'> };

export type StatusOutcome =
  | { ok: true; from: GarmentStatus; to: GarmentStatus }
  /** Not in `ownerId`'s wardrobe: a 404 like an unknown id. */
  | { ok: false; reason: 'not-found' }
  /** The garment's status does not take the event (a 409): where it stays. */
  | { ok: false; reason: 'not-allowed'; status: GarmentStatus };

/**
 * The one writer of a garment's status after its insert: locks the row,
 * asks the machine (garmentStatusTransition) and writes its answer, with
 * what a purchase records. Every archive, restore and "Bought it" (the
 * routes, the seed, buyGarment) comes through here. A savepoint inside a
 * caller's transaction.
 */
export function setGarmentStatus(
  db: Queryable,
  id: number,
  ownerId: number,
  change: StatusChange,
): Promise<StatusOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: garment.status })
      .from(garment)
      .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)))
      .for('update');
    if (!row) return { ok: false, reason: 'not-found' };
    const move = garmentStatusTransition(row.status, change.event);
    if (!move.ok) {
      return { ok: false, reason: 'not-allowed', status: move.status };
    }
    await tx
      .update(garment)
      .set({
        status: move.to,
        ...(change.event === 'buy' && {
          acquiredOn: change.acquiredOn,
          price: change.price,
        }),
      })
      .where(eq(garment.id, id));
    return move;
  });
}

export type BuyOutcome =
  | (StatusOutcome & { ok: false })
  | {
      ok: true;
      /** The replaced garment archived with it; null when not asked or not in the closet. */
      archivedReplaced: number | null;
    };

/**
 * "Bought it": the wishlist item moves to the closet with its purchase,
 * and, only when asked (never silently), the garment it replaces goes to
 * the archive, in one transaction. A replaced garment that is no longer in
 * the closet (archived meanwhile) is left as it is.
 */
export function buyGarment(
  db: Queryable,
  id: number,
  ownerId: number,
  purchase: Purchase & { archiveReplaced: boolean },
): Promise<BuyOutcome> {
  return db.transaction(async (tx) => {
    const bought = await setGarmentStatus(tx, id, ownerId, {
      event: 'buy',
      acquiredOn: purchase.acquiredOn,
      price: purchase.price,
    });
    if (!bought.ok) return bought;
    if (!purchase.archiveReplaced) return { ok: true, archivedReplaced: null };
    const [row] = await tx
      .select({ replaces: garment.replacesGarmentId })
      .from(garment)
      .where(eq(garment.id, id));
    if (row.replaces === null) return { ok: true, archivedReplaced: null };
    const archived = await setGarmentStatus(tx, row.replaces, ownerId, {
      event: 'archive',
    });
    return { ok: true, archivedReplaced: archived.ok ? row.replaces : null };
  });
}
