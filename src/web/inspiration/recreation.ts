import type { IsoDate } from '../../calendar-date';
import type { Db } from '../../db/client';
import {
  type Recreation,
  type RecreateRequest,
  recreateLook,
} from '../../wardrobe/recreate';
import type { RecreatePoolGarment } from '../gallery/queries';
import {
  type InspirationDetail,
  recreateInputs,
  type StoredPiece,
  wishlisted,
} from './queries';

/** A look and the closet's closest garments to each of its pieces. */
export interface LookRecreation {
  look: InspirationDetail;
  recreation: Recreation<RecreatePoolGarment>;
}

/**
 * "Recreate this look" (#22b) for the owner's look `id`: one statement for
 * the look, the closet and its rules (recreateInputs), then the pure
 * matching. NotFound when the look is not theirs. The match view's and
 * MCP's get_inspiration (#22d), so the agent reads what the page shows.
 */
export async function recreateOwnLook(
  db: Db,
  id: number,
  ownerId: number,
  today: IsoDate,
): Promise<LookRecreation> {
  const { look, closet, avoid, rules } = await recreateInputs(
    db,
    id,
    ownerId,
    today,
  );
  return {
    look,
    recreation: recreateClosetPieces(look.pieces, { closet, avoid, rules }),
  };
}

/**
 * recreateLook over the pieces still to match: a piece already on the
 * wishlist has its choice made, so it takes no part in the assignment (it
 * would reserve a garment a later piece needs). Results come back in the
 * look's piece order, a wishlisted piece with no matches.
 */
function recreateClosetPieces(
  pieces: readonly StoredPiece[],
  request: Omit<RecreateRequest<RecreatePoolGarment>, 'pieces' | 'saved'>,
): Recreation<RecreatePoolGarment> {
  const open = pieces.flatMap((piece, index) =>
    wishlisted(piece) ? [] : [index],
  );
  const found = recreateLook({
    ...request,
    pieces: open.map((index) => pieces[index]),
    saved: open.map((index) => pieces[index].matched?.id ?? null),
  });
  const result: Recreation<RecreatePoolGarment> = {
    pieces: pieces.map(() => ({ matches: [], repicked: false })),
    unfixed: found.unfixed.map((at) => open[at]),
  };
  open.forEach((index, at) => (result.pieces[index] = found.pieces[at]));
  return result;
}
