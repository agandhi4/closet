import {
  destinationQuery,
  type OutfitDestination,
} from '../outfits/destination';

/**
 * Styling's addresses (#42): the page, its fragments and every link into
 * it, built from parsed values. The dock's Style tab is STYLING_PATH
 * (layout/sections.ts).
 */

export const STYLING_PATH = '/styling';
/** The next page of a row's strip (its sentinel). */
export const STYLING_GARMENTS_PATH = `${STYLING_PATH}/garments`;
/** One more row of a role ("Add row"). */
export const STYLING_ROW_PATH = `${STYLING_PATH}/row`;
/** Shuffle: the rows again, the unlocked ones filled by the generator. */
export const STYLING_SHUFFLE_PATH = `${STYLING_PATH}/shuffle`;

export interface StylingState {
  /** `?for=`: where Save plans the outfit (a day, a trip) or none. */
  destination?: OutfitDestination;
  /** `?capsule=`: every row cycles only this capsule's garments. */
  capsuleId?: number;
  /**
   * `?picks=1`: Include picks (#335), the garments offered to style with on
   * the strips, badged "To buy". Never with a destination.
   */
  picks?: boolean;
  /** `?with=`: this garment chosen and locked ("Style this"). */
  withId?: number;
  /** `?outfit=`: a saved outfit opened to change it (its edit). */
  outfitId?: number;
  /** `?ownerId=`: a wardrobe shared with the requester, browsed. */
  ownerId?: number;
  /** `?returnTo=`: Back, and where a saved edit goes (already safeReturnTo'd). */
  returnTo?: string;
}

/**
 * The page (or one of its fragments, `path`) for `state`, plus `extra`
 * parameters (a fragment's own). Only `returnTo` is a path of its own and
 * is encoded; everything else is a parsed id, date or occasion.
 */
export function stylingUrl(
  state: StylingState,
  path: string = STYLING_PATH,
  extra: string[] = [],
): string {
  const query = [
    state.destination && destinationQuery(state.destination),
    state.capsuleId !== undefined && `capsule=${state.capsuleId}`,
    state.picks && 'picks=1',
    state.withId !== undefined && `with=${state.withId}`,
    state.outfitId !== undefined && `outfit=${state.outfitId}`,
    state.ownerId !== undefined && `ownerId=${state.ownerId}`,
    state.returnTo !== undefined &&
      `returnTo=${encodeURIComponent(state.returnTo)}`,
    ...extra,
  ].filter(Boolean);
  return query.length > 0 ? `${path}?${query.join('&')}` : path;
}

/** "Style this" on a garment: Styling with the garment chosen and locked in its row. */
export function styleThisUrl(garmentId: number, ownerId?: number): string {
  return stylingUrl({ withId: garmentId, ownerId });
}
