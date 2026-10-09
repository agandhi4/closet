import type { GarmentMarkKind } from '../../wardrobe/marks';
import type { CollagePieceView } from '../outfits/collage';

/**
 * The first blocking mark (archived, away) on any piece of any of a day's
 * entries that the month cell does not draw itself: the pieces of its first
 * entry's body (bodyOf), so a lent bag, or anything in a later entry, still
 * shows. Matches cellLabel, which announces every entry's warnings. The
 * wash is not blocking, and a drawn piece keeps its own dot.
 */
export function hiddenBlocking(
  entries: readonly { pieces: readonly CollagePieceView[] }[],
  drawn: readonly CollagePieceView[],
): GarmentMarkKind | undefined {
  return entries
    .flatMap((entry) => entry.pieces)
    .filter((piece) => !drawn.includes(piece))
    .flatMap((piece) => piece.marks ?? [])
    .find((mark) => mark === 'archived' || mark.startsWith('away:'));
}
