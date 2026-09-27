/**
 * The app's sections, the places the dock names, and the one route table
 * that says which section a page belongs to (docs/plans/2026-09-26-redesign.md,
 * "Where every route goes"). A section owns its whole subtree: a garment, a
 * filtered grid and a capsule are Wardrobe, an outfit page Outfits, any week
 * Calendar; Today is `/` alone. Used by the dock (dock.tsx) for its tabs and
 * the active one, and by page-cache.ts for the tab roots the service worker
 * opens stale (the worker bundles this file: keep it free of Node and DOM).
 */
export type Section = 'today' | 'wardrobe' | 'outfits' | 'calendar';

/** Each section's root page: its dock tab's link. */
export const SECTION_HOME: Readonly<Record<Section, string>> = {
  today: '/',
  wardrobe: '/wardrobe',
  outfits: '/outfits',
  calendar: '/calendar',
};

/**
 * The dock's tabs, in order: the redesign's recommendation (Today first,
 * #15), which the owner has not confirmed yet (#43, decision 2). Taking
 * Today out of the dock is taking it out of this list; `/` stays Today.
 */
export const DOCK_TABS: readonly Section[] = [
  'today',
  'wardrobe',
  'outfits',
  'calendar',
];

/**
 * Path roots, each with its subtree. Capsules are named subsets of the
 * wardrobe, so they are Wardrobe too; trips (#10) are the Calendar's Trips
 * tab (the redesign's "Calendar › Trips"), so they are Calendar. Pages outside every root (the profile,
 * sharing, the public share page, /about) belong to no section. `/` is
 * matched on its own: every path starts with it.
 */
const SECTION_ROOTS: readonly (readonly [root: string, section: Section])[] = [
  ['/wardrobe', 'wardrobe'],
  ['/capsules', 'wardrobe'],
  ['/outfits', 'outfits'],
  ['/calendar', 'calendar'],
  ['/trips', 'calendar'],
];

/**
 * The section a request path belongs to, query and fragment ignored. Matches
 * whole segments: `/wardrobe-share/manage` is not the wardrobe.
 */
export function sectionOf(path: string): Section | undefined {
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname === SECTION_HOME.today) return 'today';
  for (const [root, section] of SECTION_ROOTS) {
    if (pathname === root || pathname.startsWith(`${root}/`)) return section;
  }
  return undefined;
}
