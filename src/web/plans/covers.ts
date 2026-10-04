import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  file,
  garment,
  planItem,
  planItemCandidate,
  planLook,
  wardrobePlan,
} from '../../db/schema';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { onWishlist } from '../wardrobe/status';
import {
  type LookSlotView,
  lookSlotsSql,
  type SlotRow,
  withSlots,
} from './looks';

/**
 * The plans list's covers (#302): a photo row per plan, the plan's looks
 * first (a collage each, loved before the rest, then oldest first) then its
 * items' top candidates, up to COVER_CELLS in all, with the count of looks
 * the card says. Read for every plan in ONE statement, whatever their
 * number (a read per plan would pay a round trip each in production,
 * #156), in parallel with the list's own reads.
 */
export const COVER_CELLS = 5;

export type CoverCell =
  | { kind: 'look'; name: string; slots: LookSlotView[] }
  | { kind: 'photo'; name: string | null; photo: SignablePhotoRef };

export interface PlanCover {
  cells: CoverCell[];
  /** Looks the owner has not declined: "N looks" on the card. */
  looks: number;
}

type CoverRow = {
  planId: number;
  looks: number;
  topLooks: { name: string; slots: SlotRow[] }[];
  candidates: { name: string | null; photo: SignablePhotoRef }[];
};

/**
 * `ownerId`'s plans' covers by plan id (every plan has an entry). A look
 * with no photo among its usable pieces is no cover (judged in the
 * statement, before the per-plan limit, so it never takes a place). A candidate is its
 * item's first (the agent's rank, then the oldest link) among those with a
 * photo, only while on the wishlist and only of an accepted item (the "N items"
 * the card says counts the accepted ones; onWishlist is the shopping list's rule).
 */
export async function planCovers(
  db: Db,
  ownerId: number,
): Promise<Map<number, PlanCover>> {
  const { rows } = await db.execute<CoverRow>(sql`
    select ${wardrobePlan.id} as "planId",
      (select count(*)::int from ${planLook}
        where ${planLook.planId} = ${wardrobePlan.id}
          and ${planLook.reaction} <> 'declined') as looks,
      (select coalesce(json_agg(json_build_object(
          'name', top.name, 'slots', top.slots
        ) order by top.loved desc, top.id), '[]')
        from (
          select shown.id, shown.name, shown.loved, shown.slots
          from (
            select ${planLook.id} as id, ${planLook.name} as name,
              ${planLook.reaction} = 'loved' as loved,
              ${lookSlotsSql(ownerId)} as slots
            from ${planLook}
            where ${planLook.planId} = ${wardrobePlan.id}
              and ${planLook.reaction} <> 'declined'
          ) shown
          where exists (
            select from json_array_elements(shown.slots) piece
            where piece->>'photo' is not null
              and (piece->>'status' = 'closet'
                or (piece->>'status' = 'wishlist'
                  and (piece->>'candidate')::boolean)))
          order by shown.loved desc, shown.id
          limit ${COVER_CELLS}
        ) top) as "topLooks",
      (select coalesce(json_agg(json_build_object(
          'name', one.name, 'photo', one.photo
        ) order by one.item_id), '[]')
        from (
          select distinct on (${planItem.id}) ${planItem.id} as item_id,
            ${garment.name} as name, ${photoRefJson} as photo
          from ${planItemCandidate}
          inner join ${planItem} on ${planItem.id} = ${planItemCandidate.planItemId}
          inner join ${garment} on ${garment.id} = ${planItemCandidate.garmentId}
          inner join ${file} on ${file.id} = ${garment.photoId}
          where ${planItem.planId} = ${wardrobePlan.id}
            and ${planItem.review} = 'accepted'
            and ${garment.ownerId} = ${ownerId}
            and ${onWishlist()}
          order by ${planItem.id}, ${planItemCandidate.rank} asc nulls last,
            ${planItemCandidate.createdAt}, ${garment.id}
          limit ${COVER_CELLS}
        ) one) as candidates
    from ${wardrobePlan}
    where ${wardrobePlan.ownerId} = ${ownerId}`);
  return new Map(rows.map((row) => [row.planId, coverOf(row)]));
}

function coverOf(row: CoverRow): PlanCover {
  const looks = row.topLooks.map(
    ({ name, slots }): CoverCell => ({
      kind: 'look',
      name,
      slots: withSlots({}, slots).slots,
    }),
  );
  const photos = row.candidates.map(
    ({ name, photo }): CoverCell => ({ kind: 'photo', name, photo }),
  );
  return {
    cells: [...looks, ...photos].slice(0, COVER_CELLS),
    looks: row.looks,
  };
}
