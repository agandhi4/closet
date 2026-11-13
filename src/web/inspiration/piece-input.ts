import { Type } from '@sinclair/typebox';
import type { LookPiece } from '../../wardrobe/recreate';
import {
  GARMENT_COLORS,
  type GarmentColor,
  INSPIRATION_PIECE_ROLES,
  type InspirationPieceRole,
  PATTERNS,
  pieceCategory,
  typesOf,
} from '../../wardrobe/properties';
import { choice, pick } from '../schemas';

/**
 * A look's piece as its form posts it (piece-form.tsx): `kind` is the role
 * and, after a slash, a type of that role's category ("layer/blazer"), or
 * the role alone ("layer"), so one select picks both and a type can never
 * be another role's; `color` the main colour, `accent` the second
 * (INSPIRATION_PIECE_MAX_COLORS), `pattern`; '' is none. Only the form's
 * own options post these, so anything else is a 400 (stored data).
 */

/** What a look's piece can be: a role, then each of its types. */
export interface PieceKind {
  role: InspirationPieceRole;
  type: string | null;
}

export function pieceKindValue({ role, type }: PieceKind): string {
  return type === null ? role : `${role}/${type}`;
}

/**
 * A role's garment types (its category's): what a piece of it may be read
 * as. The JSON surfaces take role and type apart (MCP's
 * set_inspiration_pieces, the API's pieces), so each refuses a type of
 * another role with these named.
 */
export function typesOfRole(role: InspirationPieceRole): string[] {
  return typesOf(pieceCategory(role)).map(({ value }) => value);
}

/** Every kind, in the select's order: each role, its types after it. */
export const PIECE_KINDS: readonly PieceKind[] =
  INSPIRATION_PIECE_ROLES.flatMap((role) => [
    { role, type: null },
    ...typesOfRole(role).map((type) => ({ role, type })),
  ]);

export const PieceBody = Type.Object({
  kind: Type.Union(
    PIECE_KINDS.map((kind) => Type.Literal(pieceKindValue(kind))),
  ),
  color: choice(GARMENT_COLORS),
  accent: choice(GARMENT_COLORS),
  pattern: choice(PATTERNS),
});

export interface PieceFields {
  kind: string;
  color?: string;
  accent?: string;
  pattern?: string;
}

/**
 * The piece a valid body names: the main colour first, the accent second
 * (an accent alone is the main one; the same colour twice is once).
 */
export function readPiece(body: PieceFields): LookPiece {
  // The schema admits only PIECE_KINDS' values.
  const kind = PIECE_KINDS.find((k) => pieceKindValue(k) === body.kind)!;
  const named = [
    pick(GARMENT_COLORS, body.color ?? ''),
    pick(GARMENT_COLORS, body.accent ?? ''),
  ].filter((color): color is GarmentColor => color !== null);
  return {
    role: kind.role,
    type: kind.type,
    colors: [...new Set(named)],
    pattern: pick(PATTERNS, body.pattern ?? ''),
  };
}
