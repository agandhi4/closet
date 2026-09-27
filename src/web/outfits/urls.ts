import { SECTION_HOME } from '../layout/sections';
import { destinationQuery, type OutfitDestination } from './destination';

/**
 * The Outfits page's addresses, built from parsed values (nothing needs
 * encoding). The Saved tab is the dock's Outfits tab and a
 * stale-while-revalidate tab root (page-cache.ts) when it has no query.
 */

export const SAVED_PATH = SECTION_HOME.outfits;

/**
 * The Saved tab, picking for a day when `destination` is one (R5: the
 * calendar's "Pick a saved outfit"). A trip's outfits are added from the
 * trip's own page, so the grid reads a day only.
 */
export function savedUrl(destination: OutfitDestination): string {
  return destination.kind === 'day'
    ? `${SAVED_PATH}?${destinationQuery(destination)}`
    : SAVED_PATH;
}

/** An outfit's page. */
export function outfitUrl(id: number): string {
  return `${SAVED_PATH}/${id}`;
}
