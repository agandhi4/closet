import { Type } from '@sinclair/typebox';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment } from '../../db/schema';
import { QUANTITY_MAX } from '../../wardrobe/availability';
import { nearDuplicates } from '../../wardrobe/goes-with';
import {
  findType,
  GARMENT_COLORS,
  isGarmentColor,
} from '../../wardrobe/properties';
import { ownerTransaction } from '../auth/queries';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { normalizeCategory } from './garment';
import { inCloset } from './status';
import {
  BRAND_MAX,
  CATEGORY_MAX,
  ColorValue,
  LookalikesDismissed,
  OwnerQuery,
} from './validation';

/**
 * "You already have this: add a copy?" (#20; docs/plans/2026-09-26-
 * wardrobe-features.md, section 18): a garment about to land in the closet
 * judged against the closet by 18b's rule (nearDuplicates, with
 * `sameBrand`), and the write that adds copies to a closet garment instead.
 * The garment form's region (lookalike-region.tsx), its routes
 * (lookalike-routes.tsx) and the MCP tools (add_garment_from_link's
 * answer, add_garment_copy) all come here.
 */

/** Matches the form shows: the newest few. */
export const LOOKALIKES_SHOWN = 3;

/** A closet garment near-identical to the garment being added. */
export interface ClosetLookalike {
  id: number;
  name: string | null;
  category: string;
  quantity: number;
  photo: SignablePhotoRef | null;
}

/** What the form says about the garment being added, as posted. */
export interface LookalikeFields {
  category: string;
  type: string;
  colors: readonly string[];
  brand: string;
}

/**
 * The closet garments of `ownerId` near-identical to `fields` (a form, or
 * a garment just saved: `exceptId`), newest first, at most
 * LOOKALIKES_SHOWN, leaving out the `dismissed` ones. One statement over
 * the category's garments (garment_owner_id_category_id_index); the rule
 * itself is the pure one. The form's values are read as a save reads them:
 * the category trimmed and lower case, a type only of its category (the
 * properties fragment drops one that is not), built-in colours only.
 */
export async function closetLookalikes(
  db: Db,
  ownerId: number,
  fields: LookalikeFields,
  {
    dismissed = [],
    exceptId,
  }: { dismissed?: readonly number[]; exceptId?: number } = {},
): Promise<ClosetLookalike[]> {
  const category = normalizeCategory(fields.category);
  const colors = fields.colors.filter(isGarmentColor);
  if (category === '' || colors.length === 0) return [];
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      type: garment.type,
      colors: garment.colors,
      brand: garment.brand,
      quantity: garment.quantity,
      photo: photoRefJson,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        eq(garment.ownerId, ownerId),
        eq(garment.category, category),
        inCloset(),
      ),
    )
    .orderBy(desc(garment.id));
  const skip = new Set(dismissed);
  const candidates = rows
    .filter((row) => !skip.has(row.id))
    .map((row) => ({ ...row, colors: row.colors ?? [] }));
  const probe = {
    id: exceptId,
    category,
    type: findType(category, fields.type)?.value ?? null,
    colors,
    brand: fields.brand,
  };
  return nearDuplicates(probe, candidates, { sameBrand: true })
    .slice(0, LOOKALIKES_SHOWN)
    .map(({ id, name, category, quantity, photo }) => ({
      id,
      name,
      category,
      quantity,
      photo,
    }));
}

export type AddCopiesOutcome =
  | { ok: true; from: number; to: number }
  | { ok: false; reason: 'not-found' | 'not-in-closet' | 'too-many' };

/**
 * `copies` more of the owner's closet garment `id` (its quantity), under
 * the owner lock: the one writer of "add a copy". Refused, writing nothing,
 * for a garment that is not the owner's, one not in the closet (a wishlist
 * item is not owned yet; an archived one is gone), and past QUANTITY_MAX.
 * The garment's photo, wears, washes and repairs are its own and stay: the
 * new copy starts clean (dirty copies are counted from wears, capped at the
 * quantity).
 */
export function addCopies(
  db: Db,
  ownerId: number,
  id: number,
  copies: number,
): Promise<AddCopiesOutcome> {
  return ownerTransaction(db, ownerId, 'addCopies', async (tx) => {
    const [row] = await tx
      .select({ status: garment.status, quantity: garment.quantity })
      .from(garment)
      .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)))
      .for('update');
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.status !== 'closet') return { ok: false, reason: 'not-in-closet' };
    const to = row.quantity + copies;
    if (to > QUANTITY_MAX) return { ok: false, reason: 'too-many' };
    await tx.update(garment).set({ quantity: to }).where(eq(garment.id, id));
    return { ok: true, from: row.quantity, to };
  });
}

/**
 * GET /wardrobe/lookalikes: the form's fields that decide a match, as the
 * region's refresh sends them (hx-params), and the dismissed list. The
 * fields are the garment form's own shapes and caps.
 */
export const LookalikesQuery = Type.Object({
  ...OwnerQuery.properties,
  category: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  type: Type.Optional(Type.String({ maxLength: 40 })),
  color: Type.Optional(
    Type.Array(ColorValue, { maxItems: GARMENT_COLORS.length * 2 }),
  ),
  brand: Type.Optional(Type.String({ maxLength: BRAND_MAX })),
  lookalikesDismissed: LookalikesDismissed,
});
