import type { ImageRef } from '../../file/file-url/image-url';
import { GarmentCategory } from '../../wardrobe/garment-category.enum';
import { t, type StringKey } from '../i18n';

/**
 * The outfit builder's rows (GET /outfits/new, the edit form, and the
 * prev/next row fragment). A row is a category and at most one garment of
 * it; prev and next step through the category's cycle: position 0 is "no
 * garment", then 1..count are the owner's unarchived garments of that
 * category, newest first, and both ends wrap through 0. Pure: the queries
 * (queries.ts) fetch only the garment each row shows plus the counts.
 */

/** A garment as a builder row shows it (and the detail modal opens). */
export interface RowGarment {
  id: number;
  name: string | null;
  brand: string | null;
  color: string | null;
  size: string | null;
  notes: string | null;
  archived: boolean;
  photo: ImageRef | null;
}

export interface BuilderRow {
  category: string;
  label: string;
  /** Unarchived garments in the category: the ones prev/next step through. */
  count: number;
  /**
   * The row's position in the cycle; null when it shows a garment outside
   * it (archived, or moved to another category since the outfit was saved),
   * which prev/next can step away from but not back to.
   */
  index: number | null;
  prevIndex: number;
  nextIndex: number;
  garment: RowGarment | null;
}

/** A category of the wardrobe with its newest unarchived garment. */
export interface CategoryHead {
  category: string;
  count: number;
  garment: RowGarment;
}

/** A saved slot with what the edit form needs to place it in its cycle. */
export interface SavedSlot {
  category: string;
  /** Unarchived garments in the slot's category. */
  count: number;
  /** How many of those are newer (higher id) than the slot's garment. */
  newer: number;
  garment: (RowGarment & { category: string }) | null;
}

const CATEGORY_LABELS: Record<GarmentCategory, StringKey> = {
  [GarmentCategory.ACCESSORIES]: 'CATEGORY_ACCESSORIES',
  [GarmentCategory.BAGS]: 'CATEGORY_BAGS',
  [GarmentCategory.OUTERWEAR]: 'CATEGORY_OUTERWEAR',
  [GarmentCategory.DRESSES]: 'CATEGORY_DRESSES',
  [GarmentCategory.TOPS]: 'CATEGORY_TOPS',
  [GarmentCategory.BOTTOMS]: 'CATEGORY_BOTTOMS',
  [GarmentCategory.FOOTWEAR]: 'CATEGORY_FOOTWEAR',
  [GarmentCategory.OTHER]: 'CATEGORY_OTHER',
};

const ENUM_ORDER: string[] = Object.values(GarmentCategory);

function isKnownCategory(value: string): value is GarmentCategory {
  return ENUM_ORDER.includes(value);
}

/** The built-in categories' translated names; a custom category is its own label. */
export function categoryLabel(category: string): string {
  const normalized = category.toLowerCase();
  return isKnownCategory(normalized)
    ? t(CATEGORY_LABELS[normalized])
    : category;
}

/** Built-in categories in enum order, then custom ones sorted. */
export function orderCategories(categories: string[]): string[] {
  return [
    ...ENUM_ORDER.filter((category) => categories.includes(category)),
    ...categories.filter((category) => !isKnownCategory(category)).sort(),
  ];
}

/**
 * A requested cycle position made valid: a missing one is the newest
 * garment (1), and anything outside 0..count is pulled to the nearer end.
 */
export function clampIndex(index: number | undefined, count: number): number {
  return Math.min(Math.max(index ?? 1, 0), count);
}

/** A row at a valid cycle position, showing `garment` (null at 0). */
export function cycleRow(
  category: string,
  count: number,
  index: number,
  garment: RowGarment | null,
): BuilderRow {
  return {
    category,
    label: categoryLabel(category),
    count,
    index,
    prevIndex: index === 0 ? count : index - 1,
    nextIndex: index === count ? 0 : index + 1,
    garment,
  };
}

/**
 * A row showing a garment outside the cycle. It sits between the `newer`
 * garments newer than it and the rest, so prev goes to the nearest newer one
 * (or "no garment") and next to the nearest older one (or "no garment").
 */
function detachedRow(
  category: string,
  count: number,
  newer: number,
  garment: RowGarment,
): BuilderRow {
  return {
    category,
    label: categoryLabel(category),
    count,
    index: null,
    prevIndex: newer,
    nextIndex: newer + 1 > count ? 0 : newer + 1,
    garment,
  };
}

/** A new outfit: one row per category, its newest garment chosen. */
export function newOutfitRows(heads: CategoryHead[]): BuilderRow[] {
  const byCategory = new Map(heads.map((head) => [head.category, head]));
  return orderCategories([...byCategory.keys()]).map((category) => {
    const head = byCategory.get(category)!;
    return cycleRow(category, head.count, 1, head.garment);
  });
}

/**
 * A saved outfit's rows, in its order, every slot kept: an archived garment
 * stays chosen (and marked) so saving the form keeps it in the outfit.
 */
export function savedOutfitRows(slots: SavedSlot[]): BuilderRow[] {
  return slots.map(({ category, count, newer, garment }) => {
    if (!garment) return cycleRow(category, count, 0, null);
    if (garment.archived || garment.category !== category) {
      return detachedRow(category, count, newer, garment);
    }
    return cycleRow(category, count, newer + 1, garment);
  });
}
