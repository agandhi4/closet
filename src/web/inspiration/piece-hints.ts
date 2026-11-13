import type { LookPiece } from '../../wardrobe/recreate';
import {
  categoryRole,
  INSPIRATION_PIECE_MAX_COLORS,
  INSPIRATION_PIECE_ROLES,
  type InspirationPieceRole,
} from '../../wardrobe/properties';
import { guessColors, guessKind } from '../wardrobe/link-import/guess';

/**
 * What a look's title says its pieces are (#22b): a pasted page's own
 * `<title>` or product name, which 22a keeps as the look's title until the
 * owner names it ("Navy blazer, white tee"), read with the garment link
 * import's word lists (guess.ts). The title is split where it lists
 * garments (commas, "and", "with", "+", "&", "|", "/"), and each part that
 * names a garment is one hint, with that part's colours. A hint is offered,
 * never saved: the owner taps it to add the piece. Pure.
 */

// "and" and "with" only as whole words: "sandals", "without".
const LIST_SEPARATORS = /\s*(?:[,;+&|/·•]|\s-\s|\band\b|\bwith\b)\s*/i;

/** The pieces `title` names, in its order, each once; none it already has (`pieces`, by role and type). */
export function pieceHints(
  title: string | null,
  pieces: readonly LookPiece[],
): LookPiece[] {
  if (!title) return [];
  const has = new Set(pieces.map(keyOf));
  const hints: LookPiece[] = [];
  for (const part of title.split(LIST_SEPARATORS)) {
    const hint = hintOf(part);
    if (!hint || has.has(keyOf(hint))) continue;
    has.add(keyOf(hint));
    hints.push(hint);
  }
  return hints;
}

function hintOf(part: string): LookPiece | null {
  const kind = guessKind(part);
  if (!kind) return null;
  const role = categoryRole(kind.category);
  if (!isPieceRole(role)) return null;
  return {
    role,
    type: kind.type,
    colors: guessColors(part).slice(0, INSPIRATION_PIECE_MAX_COLORS),
    pattern: null,
  };
}

function isPieceRole(role: string): role is InspirationPieceRole {
  return (INSPIRATION_PIECE_ROLES as readonly string[]).includes(role);
}

function keyOf(piece: LookPiece): string {
  return `${piece.role}/${piece.type ?? ''}`;
}
