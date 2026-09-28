import { and, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment } from '../../db/schema';
import type { GarmentStatus } from '../../wardrobe/status';
import { HttpError } from '../errors';
import { t } from '../i18n';

/**
 * A save that names a garment it cannot hold is refused whole (#219):
 * nothing is written and the answer names what is missing. Never a slot
 * stored empty, never a pick that quietly drops a piece. What a save may
 * hold depends on the writer:
 * - `closet`: a pick (pickIdea: the gallery, Styling's Save of a new
 *   outfit, Today, a trip, a replace, pick_outfit): garments to wear now.
 * - `owned`: a slot write (createOutfit, updateOutfit: the outfit form,
 *   Styling's Save of a saved outfit, create_outfit, the seed): the closet
 *   and the archive, so an outfit keeps an archived garment.
 */
export type Holdable = 'closet' | 'owned';

/** A garment a save named that it cannot hold. */
export interface GoneGarment {
  id: number;
  /**
   * The owner's garment in the wrong state (archived for a pick, on the
   * wishlist): named. Undefined for an id that is no garment of theirs
   * (deleted, another user's, never existed): those are indistinguishable,
   * and naming another user's garment would reveal it.
   */
  garment?: { name: string | null; status: GarmentStatus };
}

function holds(holdable: Holdable, status: GarmentStatus): boolean {
  return holdable === 'closet' ? status === 'closet' : status !== 'wishlist';
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
): Promise<GoneGarment[]> {
  const wanted = [...new Set(garmentIds)];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ id: garment.id, name: garment.name, status: garment.status })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), inArray(garment.id, wanted)));
  const found = new Map(rows.map((row) => [row.id, row]));
  return wanted.flatMap((id): GoneGarment[] => {
    const row = found.get(id);
    if (!row) return [{ id }];
    if (holds(holdable, row.status)) return [];
    return [{ id, garment: { name: row.name, status: row.status } }];
  });
}

function goneReason(owned: NonNullable<GoneGarment['garment']>): string {
  const name = owned.name ?? t('outfits.UNNAMED_GARMENT');
  return owned.status === 'wishlist'
    ? t('outfits.GONE_WISHLIST', { name })
    : t('outfits.GONE_ARCHIVED', { name });
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
