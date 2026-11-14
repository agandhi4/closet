import { and, eq, gte, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment, outfitCalendar } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import type { GarmentStatus } from '../../wardrobe/status';
import { addDays, type IsoDate } from '../../calendar-date';
import { weekOf } from '../calendar/calendar-view';
import { weekUrl } from '../calendar/urls';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { savedOutfitsSql } from '../outfits/queries';
import { outfitUrl } from '../outfits/urls';
import { GRID_PAGE_SIZE } from '../wardrobe/grid-page-size';
import { inCloset, onWishlist, wanted } from '../wardrobe/status';
import { garmentUrl, needUrl, WISHLIST_PATH } from '../wardrobe/urls';
import { inboxNeedIdsSql } from '../wishlist/inbox';
import { EMPTY_SEARCH, tilesUrl } from '../wardrobe/wardrobe-page';
import {
  WARM_GARMENT_CAP,
  WARM_IMAGE_CAP,
  WARM_OUTFIT_CAP,
  WARM_WISHLIST_CAP,
  type WarmList,
} from './offline-warm';

/**
 * The warm list of `ownerId`'s own wardrobe (#286): next week, every closet
 * garment's page and every outfit's (capped: the one-offs this week and
 * next hold first, since Today and the calendar open them, then the kept
 * ones newest first, #659; the other one-offs are only kept), the Muse inbox
 * (#333: the Wishlist tab, its needs' decision screens and the pages of
 * what is still wanted, capped), the closet grid's later pages, and the
 * thumbs they show. Never a tab root
 * (TAB_ROOTS): they open stale-while-revalidate, so a warmed copy would open
 * stale after the user's own edits; they are cached when first opened.
 * Always the requester's own: a grantee's device never warms a wardrobe
 * shared with them. One statement: the garments still owned or wished for,
 * every outfit with its garments' photos (what the Saved tab's two lists
 * read), the one-offs the near-term entries hold, and the needs the inbox
 * shows.
 */
export async function warmList(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<WarmList> {
  const nextWeekEnd = weekOf(addDays(weekOf(today).start, 7)).end;
  const { garments, kept, oneOffs, nearTerm, needs } = await selectScalars(db, {
    garments: ownGarmentsSql(ownerId),
    kept: savedOutfitsSql(ownerId, 'kept'),
    oneOffs: savedOutfitsSql(ownerId, 'one-offs'),
    nearTerm: plannedOutfitIdsSql(ownerId, today, nextWeekEnd),
    needs: inboxNeedIdsSql(ownerId),
  });
  const planned = new Set(nearTerm);
  const warmable = [...oneOffs.filter((row) => planned.has(row.id)), ...kept];
  const unplanned = oneOffs.filter((row) => !planned.has(row.id));
  const closet = garments.filter((row) => row.status === 'closet');
  const warmed = closet.slice(0, WARM_GARMENT_CAP);
  // The inbox, then its needs, then what is still wanted, within the cap.
  const inboxPages = [
    WISHLIST_PATH,
    ...needs.map((id) => needUrl(id, undefined)),
  ].slice(0, WARM_WISHLIST_CAP);
  const stillWanted = garments
    .filter((row) => row.wanted)
    .slice(0, WARM_WISHLIST_CAP - inboxPages.length);
  const warmedIds = new Set([...warmed, ...stillWanted].map((row) => row.id));
  const warmedOutfits = warmable.slice(0, WARM_OUTFIT_CAP);

  const thumbs = new Set<string>();
  const addThumb = (photo: SignablePhotoRef | null) => {
    if (photo) thumbs.add(imageUrl(photo, 'thumb'));
  };
  warmed.forEach((row) => addThumb(row.photo));
  warmedOutfits.forEach((row) =>
    row.garments.forEach((g) => addThumb(g.photo)),
  );
  const closetThumbs = [...thumbs].slice(0, WARM_IMAGE_CAP - WARM_WISHLIST_CAP);
  const wantedThumbs = stillWanted.flatMap((row) =>
    row.photo ? [imageUrl(row.photo, 'thumb')] : [],
  );

  return {
    pages: [
      weekUrl(addDays(weekOf(today).start, 7)),
      ...warmed.map((row) => garmentUrl(row.id, undefined)),
      ...warmedOutfits.map((row) => outfitUrl(row.id)),
      ...inboxPages,
      ...stillWanted.map((row) => garmentUrl(row.id, undefined)),
    ],
    fragments: gridPageCursors(
      closet.map((row) => row.id),
      warmed.length,
      // The closet's unranked order: every cursor is rank 0, the bare id.
    ).map((id) => tilesUrl(undefined, EMPTY_SEARCH, { rank: 0, id })),
    // The garments' thumbs come first (warmed before the outfits'), so a
    // cut falls on outfit pieces the closet pages never show; the inbox's
    // products have their own share of the cap.
    images: [...new Set([...closetThumbs, ...wantedThumbs])],
    keep: [
      ...garments
        .filter((row) => !warmedIds.has(row.id))
        .map((row) => garmentUrl(row.id, undefined)),
      ...[...warmable.slice(WARM_OUTFIT_CAP), ...unplanned].map((row) =>
        outfitUrl(row.id),
      ),
    ],
  };
}

/**
 * The outfits the owner's entries from `from` to `to` hold: the near-term
 * days Today and the calendar open, whose one-offs are warmed though no
 * saved list shows them.
 */
function plannedOutfitIdsSql(
  ownerId: number,
  from: IsoDate,
  to: IsoDate,
): SQL<number[]> {
  return sql<number[]>`(
    select coalesce(json_agg(distinct ${outfitCalendar.outfitId}), '[]')
    from ${outfitCalendar}
    where ${and(
      eq(outfitCalendar.ownerId, ownerId),
      gte(outfitCalendar.day, from),
      lte(outfitCalendar.day, to),
    )}
  )`;
}

interface OwnGarment {
  id: number;
  status: GarmentStatus;
  /** Still wanted (wanted(): on the wishlist, not set aside): warmed; a set-aside one is only kept. */
  wanted: boolean;
  photo: SignablePhotoRef | null;
}

/**
 * The owner's closet and wishlist garments, newest first, with their
 * photos. Archived ones are left out, so their cached pages go.
 */
function ownGarmentsSql(ownerId: number): SQL<OwnGarment[]> {
  return sql<OwnGarment[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'status', ${garment.status},
          'wanted', ${wanted()},
          'photo', ${photoRefJson}
        )
        order by ${garment.id} desc
      ),
      '[]'
    )
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(eq(garment.ownerId, ownerId), or(inCloset(), onWishlist()))}
  )`;
}

/**
 * Each later grid page's `before`, as gridPage pages the closet: newest
 * first, GRID_PAGE_SIZE a page, and a page after every full one that has
 * more behind it. `ids` is the whole closet, newest first; only pages whose
 * every tile is among the first `warmed` are listed, so an offline scroll
 * never shows a tile whose page and thumb were not warmed (it stops at the
 * last whole page, its sentinel failing like any uncached fragment).
 */
function gridPageCursors(ids: number[], warmed: number): number[] {
  const cursors: number[] = [];
  for (
    let end = GRID_PAGE_SIZE;
    end < ids.length && Math.min(end + GRID_PAGE_SIZE, ids.length) <= warmed;
    end += GRID_PAGE_SIZE
  ) {
    cursors.push(ids[end - 1]);
  }
  return cursors;
}
