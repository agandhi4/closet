/**
 * The wardrobe's links. `viewOwner` is the shared wardrobe a page shows
 * (undefined for the requester's own); every link and form on such a page
 * carries it as `?ownerId=`, so a grantee stays in the owner's wardrobe.
 */

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
