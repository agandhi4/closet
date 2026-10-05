import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment } from '../../db/schema';
import type { GarmentStatus } from '../../wardrobe/status';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { ownedGarment } from '../wardrobe/status';
import { outfitIsHeld, type PieceToBuy } from './references';

/**
 * A save that names a garment it cannot hold is refused whole (#219):
 * nothing is written and the answer names what is missing. Never a slot
 * stored empty, never a pick that quietly drops a piece. What a save may
 * hold depends on the writer:
 * - `closet`: a pick (pickIdea: the gallery, Styling's Save of a new
 *   outfit, Today, a trip, a replace, pick_outfit): garments to wear now.
 * - `owned`: a slot write into an outfit something holds (a calendar
 *   entry, a trip: outfitIsHeld): the closet and the archive, so an outfit
 *   keeps an archived garment.
 * - `considered`: a slot write into an outfit nothing holds (createOutfit,
 *   updateOutfit: the outfit form, Styling's Save of a saved outfit,
 *   create_outfit, the seed): owned, or on the wishlist. Such an outfit is
 *   incomplete until the piece is bought (src/web/outfits/references.ts).
 * A slot write's mode is the outfit's, never the caller's (slotHoldsSql).
 * The same rules in SQL: a pick's locked read keeps inCloset()
 * (pickedGarments, src/web/gallery/queries.ts), a slot write's
 * slotHoldsSql (insertSlots).
 */
export type Holdable = 'closet' | 'owned' | 'considered';

/** What a slot write into an outfit may hold: held, only what is owned. */
export function slotHoldable(held: boolean): Holdable {
  return held ? 'owned' : 'considered';
}

function holds(holdable: Holdable, status: GarmentStatus): boolean {
  switch (holdable) {
    case 'closet':
      return status === 'closet';
    case 'owned':
      return status !== 'wishlist';
    case 'considered':
      return true;
  }
}

/**
 * What a slot write into `outfitId` may hold, as one predicate over
 * `garment` for insertSlots' locked read: owned, or anything while nothing
 * holds the outfit (slotHoldable, decided in the write's own statement, so
 * it is judged under the locks the write holds).
 */
export function slotHoldsSql(outfitId: number): SQL {
  return sql`(${ownedGarment()} or not ${outfitIsHeld(sql`${outfitId}::int`)})`;
}

/** A garment a save named that it cannot hold. */
export interface GoneGarment {
  id: number;
  /**
   * The owner's garment in the wrong state (archived for a pick, on the
   * wishlist): named. Undefined for an id that is no garment of theirs
   * (deleted, another user's, never existed): those are indistinguishable,
   * and naming another user's garment would reveal it. `outfitHeld`: a
   * wishlist garment refused because the outfit is planned or packed
   * (a slot write's `owned` mode), not because it is a wishlist item.
   */
  garment?: { name: string | null; status: GarmentStatus; outfitHeld?: true };
}

/** An owner's garment as a save judges it: what it may hold, and the slot it fills. */
export interface NamedGarment {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
}

/**
 * `ownerId`'s garments among `garmentIds`, by id, whatever their status:
 * one statement. goneGarments' read, and create_outfit's (MCP), which
 * takes each slot's category from it and judges the save with goneOf, so
 * refusing costs no second read (#172).
 */
export async function namedGarments(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
): Promise<Map<number, NamedGarment>> {
  const wanted = [...new Set(garmentIds)];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      status: garment.status,
    })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), inArray(garment.id, wanted)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Which of `garmentIds` a save of `ownerId`'s cannot hold, in the order
 * given. One statement. Read after the write refused (or inside its
 * transaction, as insertSlots does), so it names what the refusal saw.
 */
export async function goneGarments(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
  holdable: Holdable,
  { outfitHeld = false }: { outfitHeld?: boolean } = {},
): Promise<GoneGarment[]> {
  return goneOf(
    await namedGarments(db, ownerId, garmentIds),
    garmentIds,
    holdable,
    outfitHeld,
  );
}

/**
 * goneGarments over garments already read (namedGarments). `outfitHeld`:
 * the writer read that something holds the outfit (insertSlots, the only
 * one that does), so a wishlist garment is named as refused for that; never
 * inferred from the mode.
 */
export function goneOf(
  found: ReadonlyMap<number, NamedGarment>,
  garmentIds: readonly number[],
  holdable: Holdable,
  heldOutfit = false,
): GoneGarment[] {
  const wanted = [...new Set(garmentIds)];
  return wanted.flatMap((id): GoneGarment[] => {
    const row = found.get(id);
    if (!row) return [{ id }];
    if (holds(holdable, row.status)) return [];
    const outfitHeld = heldOutfit && row.status === 'wishlist';
    return [
      {
        id,
        garment: {
          name: row.name,
          status: row.status,
          ...(outfitHeld && { outfitHeld }),
        },
      },
    ];
  });
}

function goneReason(owned: NonNullable<GoneGarment['garment']>): string {
  const name = owned.name ?? t('outfits.UNNAMED_GARMENT');
  if (owned.status !== 'wishlist') return t('outfits.GONE_ARCHIVED', { name });
  return owned.outfitHeld
    ? t('outfits.GONE_WISHLIST_HELD', { name })
    : t('outfits.GONE_WISHLIST', { name });
}

/** The refusal's words: each named garment, then how many are gone. */
function refusalMessage(gone: readonly GoneGarment[]): string {
  const reasons = gone.flatMap((g) =>
    g.garment ? [goneReason(g.garment)] : [],
  );
  const missing = gone.length - reasons.length;
  if (missing === 1) reasons.push(t('outfits.GONE_ONE'));
  if (missing > 1) reasons.push(t('outfits.GONE_MANY', { count: missing }));
  return t('outfits.NOT_SAVED', { reasons: reasons.join('; ') });
}

/**
 * The refusal of a save that named garments it cannot hold: nothing was
 * written. A 409 when every one is the owner's (archived, on the
 * wishlist: named, so the person knows which to change); a 404 when any
 * is not a garment of theirs, the answer an unknown id gets everywhere
 * (CLAUDE.md, Request security: refusals do not reveal ids), with the
 * same words. Styling answers it with its page, the rows kept
 * (src/web/styling); anywhere else it is the error page or the MCP tool
 * error.
 */
export class OutfitGarmentsGone extends HttpError {
  constructor(readonly gone: readonly GoneGarment[]) {
    super(gone.every((g) => g.garment) ? 409 : 404, refusalMessage(gone), {
      logDetail: `garments ${describeGone(gone)}`,
    });
    this.name = 'OutfitGarmentsGone';
  }
}

/** The gone garments for a log line: `12 (archived), 14 (not theirs)`. */
export function describeGone(gone: readonly GoneGarment[]): string {
  return gone
    .map((g) => `${g.id} (${g.garment ? g.garment.status : 'not theirs'})`)
    .join(', ');
}

/**
 * The refusal for garments a pick or a save could not hold, as goneGarments
 * read them. Should none be gone by then (restored between the refusal and
 * the lookup), the plain 404 a pick has always answered.
 */
export function garmentsGoneRefusal(gone: readonly GoneGarment[]): HttpError {
  return gone.length > 0
    ? new OutfitGarmentsGone(gone)
    : new HttpError(404, 'Garment not found');
}

/**
 * The refusal of a pick or a save that found garments it cannot hold,
 * named as they are now (garmentsGoneRefusal over goneGarments).
 */
export async function garmentsGoneError(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
  holdable: Holdable,
): Promise<HttpError> {
  return garmentsGoneRefusal(
    await goneGarments(db, ownerId, garmentIds, holdable),
  );
}

/**
 * The refusal of a write that would plan, pack or wear an incomplete
 * outfit (src/web/outfits/references.ts): a 409 naming the pieces to buy
 * first. Thrown by the writers themselves (upsertEntry, planToWear,
 * setEntryOutfit, addTripOutfit) after a statement that wrote nothing, so
 * a caller's transaction rolls back whole: a save planned on a day saves
 * nothing either. Pages answer the error page, the MCP tools the tool
 * error, with the same words.
 */
export class OutfitIncomplete extends HttpError {
  constructor(
    readonly outfitId: number,
    readonly pieces: readonly PieceToBuy[],
  ) {
    super(
      409,
      t('outfits.INCOMPLETE', {
        pieces: pieces
          .map((piece) => piece.name ?? t('outfits.UNNAMED_GARMENT'))
          .join(', '),
      }),
      {
        logDetail: `outfit ${outfitId} holds ${pieces.length} piece(s) not bought yet: ${pieces.map((p) => p.id).join(', ')}`,
      },
    );
    this.name = 'OutfitIncomplete';
  }
}
