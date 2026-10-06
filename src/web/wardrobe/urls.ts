import { idListValue } from './validation';

/**
 * The wardrobe's links, its capsules' included. `viewOwner` is the shared
 * wardrobe a page shows (undefined for the requester's own); every link and
 * form on such a page carries it as `?ownerId=`, so a grantee stays in the
 * owner's wardrobe.
 */

/** Adding a garment from a link (link-import/routes.tsx); the manifest's share target. */
export const LINK_IMPORT_PATH = '/wardrobe/new/from-link';
/** Picking another of the page's photos on the prefilled form. */
export const LINK_PHOTO_PATH = `${LINK_IMPORT_PATH}/photo`;

/**
 * The add sheet's camera and library (#97): the photo is stored as a
 * pending photo, then the new garment form opens with it.
 */
export const PHOTO_ADD_PATH = '/wardrobe/new/photo';

/** Discarding a draft of a multi-photo batch (#200); the queue moves on. */
export const DRAFT_DISCARD_PATH = '/wardrobe/new/drafts/discard';

/**
 * A draft of a batch on the new garment form (#200): `saved` is the
 * garments its batch saved so far, and `leftOut` the photos its upload
 * could not read (the first draft only).
 */
export function draftUrl(
  viewOwner: number | undefined,
  photo: string,
  saved: readonly number[],
  leftOut: readonly string[] = [],
): string {
  const url = wardrobeUrl(
    viewOwner,
    { photo, saved: idListValue(saved) },
    '/wardrobe/new',
  );
  if (leftOut.length === 0) return url;
  const names = new URLSearchParams(
    leftOut.map((name) => ['leftOut', name.slice(0, 255)]),
  );
  return `${url}&${names.toString()}`;
}

/**
 * Where a batch's queue ends (#200): select mode with the garments it
 * saved checked, so "Set…" tags them together.
 */
export function batchDoneUrl(
  viewOwner: number | undefined,
  saved: readonly number[],
): string {
  return wardrobeUrl(viewOwner, { select: '1', checked: idListValue(saved) });
}

/** Tagging mode (tag-page.tsx): one card at a time, from the newest. */
export const TAG_PATH = '/wardrobe/tag';

/** The Wardrobe's Wishlist tab (src/web/wishlist); under /wardrobe, so the dock marks it. */
export const WISHLIST_PATH = '/wardrobe/wishlist';

/**
 * The Wardrobe's Laundry tab (src/web/wears): the signed-in user's own
 * hamper, outside /wardrobe (it takes no `?ownerId=`), so layout/sections.ts
 * names it Wardrobe on its own.
 */
export const LAUNDRY_PATH = '/laundry';

/**
 * Where a new garment lands, as the new form and the link import carry it
 * in their URLs (DestinationQuery): the closet adds nothing.
 */
export interface Destination {
  to: 'closet' | 'wishlist';
  /** A wishlist item's replaced garment (a garment's "Find a replacement"). */
  replaces?: number;
  /**
   * The owner's order item a new closet garment is added from (#25, "From
   * your orders"): marked added when the garment is saved, in its
   * transaction. Posted by the form (GarmentBody.orderItem), never in a URL.
   */
  orderItem?: number;
  /**
   * The owner's open Muse need a new closet garment was bought for, instead
   * of its picks ("Bought a different one", #333): the need is settled by
   * the garment when it is saved, in its transaction (decide's `bought`).
   */
  forNeed?: number;
}

export const TO_CLOSET: Destination = { to: 'closet' };

/** The destination's query parameters (none for the closet). */
export function destinationParams(
  destination: Destination,
): Record<string, string | number | undefined> {
  return destination.to === 'closet'
    ? { forNeed: destination.forNeed }
    : { to: destination.to, replaces: destination.replaces };
}

/** `path` with the query `params`, empty values left out. */
function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(name, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** The grid (or POST /wardrobe), with filters or flags when given. */
export function wardrobeUrl(
  viewOwner: number | undefined,
  params: Record<string, string | number | undefined> = {},
  path = '/wardrobe',
): string {
  return withQuery(path, { ...params, ownerId: viewOwner });
}

/** A garment's page, or one of its sub-routes (`suffix`: '/edit', '/clone', ...). */
export function garmentUrl(
  id: number,
  viewOwner: number | undefined,
  suffix = '',
  params: Record<string, string | number | undefined> = {},
): string {
  return withQuery(`/wardrobe/${id}${suffix}`, {
    ...params,
    ownerId: viewOwner,
  });
}

/**
 * A Muse need's decision screen (src/web/wishlist/group-page.tsx), or one of
 * its decisions (`suffix`: '/dismiss', '/undo').
 */
export function needUrl(
  id: number,
  viewOwner: number | undefined,
  suffix = '',
  params: Record<string, string | number | undefined> = {},
): string {
  return withQuery(`${WISHLIST_PATH}/needs/${id}${suffix}`, {
    ...params,
    ownerId: viewOwner,
  });
}

/** `path` (a same-site path, possibly with a query) with `params` set on it. */
export function withParams(
  path: string,
  params: Record<string, string | number>,
): string {
  const url = new URL(path, 'http://closet.invalid');
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }
  return url.pathname + url.search + url.hash;
}

/** The capsule list, or a capsule's page or one of its sub-routes (`suffix`: '/edit', '/garments'). */
export function capsuleUrl(
  id: number | undefined,
  viewOwner: number | undefined,
  suffix = '',
  params: Record<string, string | number | undefined> = {},
): string {
  return withQuery(
    id === undefined ? '/capsules' : `/capsules/${id}${suffix}`,
    {
      ...params,
      ownerId: viewOwner,
    },
  );
}
