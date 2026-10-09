import { Type } from '@sinclair/typebox';
import {
  and,
  arrayContained,
  arrayContains,
  eq,
  isNull,
  lte,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import { QUANTITY_MAX } from '../../wardrobe/availability';
import { nearDuplicates } from '../../wardrobe/goes-with';
import {
  findType,
  GARMENT_COLORS,
  type GarmentColor,
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
} from './garment-input';
import { OwnerQuery } from '../schemas';

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

/** The form's values as a save reads them; undefined when nothing can match. */
function probeOf(fields: LookalikeFields) {
  const category = normalizeCategory(fields.category);
  const colors = fields.colors.filter(isGarmentColor);
  if (category === '' || colors.length === 0) return undefined;
  return {
    category,
    type: findType(category, fields.type)?.value ?? null,
    colors,
    brand: fields.brand,
  };
}

/** A closet garment that may be a lookalike, as closetLookalikesSql reads it. */
export interface LookalikeCandidate extends ClosetLookalike {
  type: string | null;
  colors: GarmentColor[] | null;
  brand: string | null;
}

/**
 * The closet garments of `ownerId` that may be near-identical to `fields`
 * (a form, or a garment just saved), newest first, as a scalar subquery (a
 * JSON array) for readClosetLookalikes; undefined when nothing can match
 * (no category or no built-in colour), so nothing is read. The form's
 * values are read as a save reads them: the category trimmed and lower
 * case, a type only of its category (the properties fragment drops one
 * that is not), built-in colours only. The garment form reads it with its
 * other lists in one statement (formContext, form-context.ts). The same
 * category (garment_owner_id_category_id_index), type and colours as a set
 * are asked here as well as by the rule (nearDuplicates), only so that the
 * rows read are the few the rule can keep, not the whole category (#161);
 * the rule stays the one judge, the brand included.
 */
export function closetLookalikesSql(
  ownerId: number,
  fields: LookalikeFields,
): SQL<LookalikeCandidate[]> | undefined {
  const probe = probeOf(fields);
  if (!probe) return undefined;
  return sql<LookalikeCandidate[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'name', ${garment.name},
          'category', ${garment.category},
          'type', ${garment.type},
          'colors', ${garment.colors},
          'brand', ${garment.brand},
          'quantity', ${garment.quantity},
          'photo', ${photoRefJson}
        )
        order by ${garment.id} desc
      ),
      '[]'
    )
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(
      eq(garment.ownerId, ownerId),
      eq(garment.category, probe.category),
      probe.type === null ? isNull(garment.type) : eq(garment.type, probe.type),
      arrayContains(garment.colors, probe.colors),
      arrayContained(garment.colors, probe.colors),
      inCloset(),
    )}
  )`;
}

/**
 * The lookalikes among closetLookalikesSql's `candidates` for `fields`,
 * judged by 18b's rule with `sameBrand` (nearDuplicates, pure), at most
 * LOOKALIKES_SHOWN, leaving out the `dismissed` ones and `exceptId` (a
 * garment just saved).
 */
export function readClosetLookalikes(
  fields: LookalikeFields,
  candidates: readonly LookalikeCandidate[],
  {
    dismissed = [],
    exceptId,
  }: { dismissed?: readonly number[]; exceptId?: number } = {},
): ClosetLookalike[] {
  const probe = probeOf(fields);
  if (!probe) return [];
  const skip = new Set(dismissed);
  const judged = candidates
    .filter((row) => !skip.has(row.id))
    .map((row) => ({ ...row, colors: row.colors ?? [] }));
  return nearDuplicates({ ...probe, id: exceptId }, judged, { sameBrand: true })
    .slice(0, LOOKALIKES_SHOWN)
    .map(({ id, name, category, quantity, photo }) => ({
      id,
      name,
      category,
      quantity,
      photo,
    }));
}

/**
 * closetLookalikesSql and readClosetLookalikes in one: the region's
 * refresh (lookalike-routes.tsx) and add_garment_from_link's answer (MCP).
 * One statement, none when nothing can match.
 */
export async function closetLookalikes(
  db: Db,
  ownerId: number,
  fields: LookalikeFields,
  options: { dismissed?: readonly number[]; exceptId?: number } = {},
): Promise<ClosetLookalike[]> {
  const { candidates } = await selectScalars(db, {
    candidates: closetLookalikesSql(ownerId, fields),
  });
  return readClosetLookalikes(fields, candidates ?? [], options);
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
 * quantity). The UPDATE carries the checks, judged on the row it locks, so
 * a copy is one statement under the lock (#161); only a refusal reads the
 * row again, to say why.
 */
export function addCopies(
  db: Db,
  ownerId: number,
  id: number,
  copies: number,
): Promise<AddCopiesOutcome> {
  return ownerTransaction(db, ownerId, 'addCopies', async (tx) => {
    const garmentOfOwner = and(
      eq(garment.id, id),
      eq(garment.ownerId, ownerId),
    );
    const [added] = await tx
      .update(garment)
      .set({ quantity: sql`${garment.quantity} + ${copies}` })
      .where(
        and(
          garmentOfOwner,
          eq(garment.status, 'closet'),
          lte(sql`${garment.quantity} + ${copies}`, QUANTITY_MAX),
        ),
      )
      .returning({ quantity: garment.quantity });
    if (added) {
      return { ok: true, from: added.quantity - copies, to: added.quantity };
    }
    const [row] = await tx
      .select({ status: garment.status })
      .from(garment)
      .where(garmentOfOwner);
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.status !== 'closet') return { ok: false, reason: 'not-in-closet' };
    return { ok: false, reason: 'too-many' };
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
