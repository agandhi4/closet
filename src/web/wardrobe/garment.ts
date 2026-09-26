import { t, type StringKey } from '../i18n';

/**
 * What a garment's fields may hold and how they read, shared by the
 * wardrobe (src/web/wardrobe) and the outfit builder (src/web/outfits).
 * Pure: no database, no request.
 */

/** The built-in categories, in the order pages list them. Others are free text. */
export enum GarmentCategory {
  ACCESSORIES = 'accessories',
  BAGS = 'bags',
  OUTERWEAR = 'outerwear',
  DRESSES = 'dresses',
  TOPS = 'tops',
  BOTTOMS = 'bottoms',
  FOOTWEAR = 'footwear',
  OTHER = 'other',
}

/**
 * The only colours a garment may carry (the form validates them on the
 * server; drizzle/0004_garment_web.sql checked stored ones against the same
 * list). garment.color joins them with commas. No name contains another, so
 * the grid's membership match cannot confuse two (queries.ts matches whole
 * comma-delimited items anyway). Each has a swatch class in
 * views/assets/main.css (`.ms-swatch--<name>`).
 */
export const GARMENT_COLORS = [
  'red',
  'pink',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'black',
  'white',
  'grey',
  'beige',
  'brown',
  'gold',
  'silver',
  'pattern',
  'other',
] as const;

export type GarmentColor = (typeof GARMENT_COLORS)[number];

export function isGarmentColor(value: string): value is GarmentColor {
  return (GARMENT_COLORS as readonly string[]).includes(value);
}

/** The stored list as its colours ('' and null are none). */
export function splitColors(color: string | null): string[] {
  return color ? color.split(',') : [];
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

/** A category as stored: trimmed and lower case, so "Tops" and "tops " are one. */
export function normalizeCategory(value: string): string {
  return value.trim().toLowerCase();
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

/** The built-in categories, then the wardrobe's own: the form's suggestions. */
export function categorySuggestions(stored: string[]): string[] {
  return orderCategories([...new Set([...ENUM_ORDER, ...stored])]);
}

const CANONICAL_SIZES = [
  'XX-Small',
  'X-Small',
  'Small',
  'Medium',
  'Large',
  'X-Large',
  'XX-Large',
  '3X-Large',
  '4X-Large',
  '5X-Large',
] as const;

// Spellings of each letter size, compared lower case without spaces or
// dashes ("x-large", "XL" and "x large" are all X-Large).
const SIZE_SPELLINGS: [string[], (typeof CANONICAL_SIZES)[number]][] = [
  [['xxxxxl', '5xl', '5xlarge', 'xxxxxlarge'], '5X-Large'],
  [['xxxxl', '4xl', '4xlarge', 'xxxxlarge'], '4X-Large'],
  [['xxxl', '3xl', '3xlarge', 'xxxlarge'], '3X-Large'],
  [['xxl', '2xl', '2xlarge', 'xxlarge'], 'XX-Large'],
  [['xl', 'xlarge'], 'X-Large'],
  [['l', 'large'], 'Large'],
  [['m', 'medium'], 'Medium'],
  [['s', 'small'], 'Small'],
  [['xs', 'xsmall'], 'X-Small'],
  [['xxs', '2xs', '2xsmall', 'xxsmall'], 'XX-Small'],
];

/**
 * A size as stored: a letter size in its canonical spelling, anything else
 * ("32", "One Size") trimmed as typed. Undefined for a blank one.
 */
export function normalizeSize(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const key = trimmed.toLowerCase().replace(/[\s-]+/g, '');
  const canonical = SIZE_SPELLINGS.find(([spellings]) =>
    spellings.includes(key),
  );
  return canonical ? canonical[1] : trimmed;
}

/** Canonical sizes in wearing order first, anything custom alphabetically after. */
export function compareSizes(a: string, b: string): number {
  const sizes: readonly string[] = CANONICAL_SIZES;
  const ai = sizes.indexOf(a);
  const bi = sizes.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}
