import {
  destinationQuery,
  type OutfitDestination,
} from '../outfits/destination';

/**
 * Where the gallery is: the Outfits page's Ideas tab and what scopes it.
 * Every link, the sentinel and the writes' redirects are built here from
 * parsed values, never from the request's own string.
 */

export const IDEAS_PATH = '/outfits/ideas';

/**
 * The one-shot flag a pick's redirect carries when the outfit already
 * existed (pickIdea's alreadySaved): the outfit and calendar pages show
 * AlreadySavedToast for it.
 */
export const ALREADY_SAVED_FLAG = 'alreadySaved';

export interface GalleryState {
  /** `?for=`: where a pick goes (OutfitDestination: a day, a trip #10, or none). */
  destination: OutfitDestination;
  /** `?capsule=`: only this capsule's garments. */
  capsuleId?: number;
  /** `?with=`: this garment in every idea ("Style this"). */
  withId?: number;
  /** `?seed=`: which ideas; Shuffle moves it. */
  seed?: number;
}

/**
 * The gallery (or `path`, its paging route) for `state`, with `page` when
 * given. The values are parsed ones (ids, a seed, a real date and a known
 * occasion), so nothing needs encoding and the URL stays readable.
 */
export function ideasUrl(
  state: GalleryState,
  options: { path?: string; page?: number } = {},
): string {
  const query = [
    destinationQuery(state.destination),
    state.capsuleId !== undefined && `capsule=${state.capsuleId}`,
    state.withId !== undefined && `with=${state.withId}`,
    state.seed !== undefined && `seed=${state.seed}`,
    options.page !== undefined && `page=${options.page}`,
  ].filter(Boolean);
  const path = options.path ?? IDEAS_PATH;
  return query.length > 0 ? `${path}?${query.join('&')}` : path;
}
