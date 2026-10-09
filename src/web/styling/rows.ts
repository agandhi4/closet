import { DRAWN_ROLES, OUTFIT_ORDER } from '../../wardrobe/generator';
import type { GarmentRole } from '../../wardrobe/properties';
import type { GarmentStatus } from '../../wardrobe/status';
import type { SignablePhotoRef } from '../files/image-url';

/**
 * Styling's rows (#42; docs/plans/2026-09-26-redesign.md, "Styling"), pure:
 * the outfit builder's cycle engine, by role instead of by category. A
 * role's **cycle** is "No garment" and then the addressed wardrobe's closet
 * garments of that role (`inCloset`, within the capsule when one is chosen),
 * newest first: what a row's strip scrolls through. The page reads only a
 * window of each cycle (queries.ts: STRIP_PAGE past the deepest selected
 * garment); the strip's sentinel fetches the rest a page at a time.
 *
 * A row is a role and its state: which garment is centred (null: "No
 * garment") and whether it is locked (Shuffle leaves it alone). The rows
 * are the state; the browser moves the centred garment by scrolling
 * (public/js/snap-strip.js) and posts the state back for Shuffle and Save.
 */

/** Garments per strip page: one centred at phone width, its neighbours, and room to swipe. */
export const STRIP_PAGE = 10;

/** Rows top to toe: the generator's outfit order, so a saved outfit reads the same everywhere. */
export const STYLING_ORDER: readonly GarmentRole[] = OUTFIT_ORDER;

/** The most rows a page carries (a role's second row is an "Add row"). */
export const MAX_ROWS = 20;

/** A garment as a strip shows it. */
export interface RowGarment {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
  photo: SignablePhotoRef | null;
}

/** The window of a role's cycle a page shows: its first `garments.length` of `count`, newest first. */
export interface RoleWindow {
  role: GarmentRole;
  count: number;
  garments: RowGarment[];
  /**
   * Include picks' garments of this role (`?picks=1`, status `wishlist`),
   * shown before the cycle on the strip and never chosen by default, nor
   * counted in `count`, nor paged: they are not the cycle (withPicks).
   */
  picks?: RowGarment[];
}

/** What a row holds, as the page posts it back. */
export interface RowState {
  role: GarmentRole;
  garmentId: number | null;
  locked: boolean;
}

export interface StylingRow extends RowState {
  /**
   * The strip after "No garment": a selected garment outside the cycle
   * first (archived since the outfit was saved: it stays chosen, and
   * saving keeps it; its status marks it), then the window of the cycle.
   */
  garments: RowGarment[];
  /** The cycle has more past the window: the next page starts before this id. */
  moreBefore?: number;
}

/** A role's order top to toe; a role outside the list (none is) sorts last. */
function rank(role: GarmentRole): number {
  const at = STYLING_ORDER.indexOf(role);
  return at === -1 ? STYLING_ORDER.length : at;
}

/** Rows (or garments) in outfit order; those of one role keep their order. */
export function topToToe<R extends { role: GarmentRole }>(
  rows: readonly R[],
): R[] {
  return [...rows].sort((a, b) => rank(a.role) - rank(b.role));
}

/**
 * What a fresh stack opens on (the dock's Style, a capsule): one row per
 * role the wardrobe has, the newest garment of each worn role chosen, so
 * the page reads as an outfit before anything is touched. Accessories,
 * bags and uncategorised garments start at "No garment" (a newest belt and
 * a newest tote are not an outfit's), and so does a one-piece when there
 * are separates to wear instead. Deterministic: a function of the
 * wardrobe, never of the day, so the page renders the same until the
 * wardrobe changes (the service worker's tab-root rule, page-cache.ts).
 */
export function freshStates(windows: readonly RoleWindow[]): RowState[] {
  const has = (role: GarmentRole) => windows.some((w) => w.role === role);
  const separates = has('top') && has('bottom');
  return topToToe(windows).map(({ role, garments }) => {
    // A role of picks alone has no cycle to open on.
    const empty =
      !DRAWN_ROLES.includes(role) ||
      (role === 'one-piece' && separates) ||
      garments.length === 0;
    return { role, garmentId: empty ? null : garments[0].id, locked: false };
  });
}

/**
 * `windows` with Include picks' garments on their roles' strips
 * (`?picks=1`), in the order given (a need's options side by side). A role
 * the closet has nothing of gets a window of picks alone, so its row
 * exists to hold them.
 */
export function withPicks(
  windows: readonly RoleWindow[],
  picks: readonly (RowGarment & { role: GarmentRole })[],
): RoleWindow[] {
  const result = windows.map((w): RoleWindow => ({ ...w }));
  for (const { role, ...pick } of picks) {
    let window = result.find((w) => w.role === role);
    if (!window) {
      window = { role, count: 0, garments: [] };
      result.push(window);
    }
    window.picks = [...(window.picks ?? []), pick];
  }
  return result;
}

/**
 * A saved outfit's rows (`?outfit=`): a row per garment, top to toe (two
 * accessories are two accessory rows), then an empty row for each other
 * role the wardrobe has, so any of them can be added.
 */
export function savedStates(
  garments: readonly { id: number; role: GarmentRole }[],
  windows: readonly RoleWindow[],
): RowState[] {
  return withEveryRole(
    garments.map((g) => ({ role: g.role, garmentId: g.id, locked: false })),
    windows,
  );
}

/**
 * `states` in outfit order, with an empty, unlocked row added for each role
 * of `windows` that has none: posted rows (Shuffle), a saved outfit's.
 */
export function withEveryRole(
  states: readonly RowState[],
  windows: readonly RoleWindow[],
): RowState[] {
  const missing = windows
    .filter((w) => !states.some((state) => state.role === w.role))
    .map((w): RowState => ({ role: w.role, garmentId: null, locked: false }));
  return topToToe([...states, ...missing]);
}

/**
 * `garmentId` chosen and locked in its role's first row ("Style this",
 * `?with=`): the row every Shuffle keeps.
 */
export function lockedOn(
  states: readonly RowState[],
  garment: { id: number; role: GarmentRole },
): RowState[] {
  const at = states.findIndex((state) => state.role === garment.role);
  const locked: RowState = {
    role: garment.role,
    garmentId: garment.id,
    locked: true,
  };
  if (at === -1) return topToToe([...states, locked]);
  return states.map((state, i) => (i === at ? locked : state));
}

/**
 * Shuffle's answer: the generator's idea in the unlocked rows it fills. A
 * drawn role (layer, one-piece, top, bottom, footwear) takes the idea's
 * garment in its first unlocked row and "No garment" in any other, so a
 * one-piece idea empties the top and bottom rows and an idea without a
 * layer empties the layer's. Locked rows, and rows the generator never
 * fills (accessories, bags, uncategorised), are left as they are.
 */
export function shuffledStates(
  states: readonly RowState[],
  idea: readonly { id: number; role: GarmentRole }[],
): RowState[] {
  const unplaced = [...idea];
  return states.map((state) => {
    if (state.locked || !DRAWN_ROLES.includes(state.role)) return state;
    const at = unplaced.findIndex((g) => g.role === state.role);
    if (at === -1) return { ...state, garmentId: null };
    const [garment] = unplaced.splice(at, 1);
    return { ...state, garmentId: garment.id };
  });
}

/**
 * What the page opens on: a saved outfit's rows (`?outfit=`), else the
 * fresh stack; with "Style this"'s garment chosen and locked (`?with=`),
 * and the day's first idea around it in the other rows.
 */
export function openingStates(
  windows: readonly RoleWindow[],
  opened: {
    saved?: readonly { id: number; role: GarmentRole }[];
    with?: { id: number; role: GarmentRole };
    idea?: readonly { id: number; role: GarmentRole }[];
  },
): RowState[] {
  const base = opened.saved
    ? savedStates(opened.saved, windows)
    : freshStates(windows);
  const locked = opened.with ? lockedOn(base, opened.with) : base;
  return opened.idea ? shuffledStates(locked, opened.idea) : locked;
}

/**
 * The page's rows: each state with its role's window. A selected garment
 * the window does not hold is one outside the cycle (`detached`: archived,
 * the only kind of owned garment no cycle has), shown first; one found in
 * neither is gone (deleted since), and the row falls back to "No garment".
 */
export function stylingRows(
  states: readonly RowState[],
  windows: readonly RoleWindow[],
  detached: readonly RowGarment[],
): StylingRow[] {
  return states.map((state) => {
    const window = windows.find((w) => w.role === state.role);
    const strip = [...(window?.picks ?? []), ...(window?.garments ?? [])];
    return {
      ...state,
      ...stripOf(state.garmentId, strip, detached),
      moreBefore: window && nextPageBefore(window),
    };
  });
}

/** A row's strip and choice: the cycle's window, led by a detached choice. */
function stripOf(
  garmentId: number | null,
  cycle: RowGarment[],
  detached: readonly RowGarment[],
): Pick<StylingRow, 'garmentId' | 'garments'> {
  if (garmentId === null || cycle.some((g) => g.id === garmentId)) {
    return { garmentId, garments: cycle };
  }
  const outside = detached.find((g) => g.id === garmentId);
  return outside
    ? { garmentId, garments: [outside, ...cycle] }
    : { garmentId: null, garments: cycle };
}

/** Where the strip's next page starts, when the cycle has more than the window. */
function nextPageBefore(window: RoleWindow): number | undefined {
  const last = window.garments.at(-1);
  return last && window.count > window.garments.length ? last.id : undefined;
}
