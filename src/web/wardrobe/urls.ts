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
