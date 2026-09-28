/**
 * What a garment is, beyond its name and photo: its category's role in an
 * outfit, and the properties stored on the garment row (type, warmth,
 * formality, materials, pattern, fit, sleeve, length, fabric weight, water
 * resistance; the care label's value sets are care.ts'). The one definition of every value set: src/db/schema.ts
 * builds the check constraints from these lists, the wardrobe's validation
 * (src/web/wardrobe/validation.ts) accepts only them, and the form offers
 * only the properties that apply to the garment's role. Pure: no database,
 * no request, no strings for people (labels live in the web layer).
 *
 * Design: docs/plans/2026-09-26-wardrobe-features.md, section 6.
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

const BUILT_IN: readonly string[] = Object.values(GarmentCategory);

export function isBuiltInCategory(value: string): value is GarmentCategory {
  return BUILT_IN.includes(value);
}

/**
 * What a garment does in an outfit. The outfit generator, the weather
 * matching and the form's choice of fields read the role, never the
 * category name. `none` is `other` and every custom category: never
 * generated into an outfit, but still given the general properties.
 */
export const GARMENT_ROLES = [
  'top',
  'bottom',
  'one-piece',
  'layer',
  'footwear',
  'accessory',
  'bag',
  'none',
] as const;
export type GarmentRole = (typeof GARMENT_ROLES)[number];

const CATEGORY_ROLES: Record<GarmentCategory, GarmentRole> = {
  [GarmentCategory.TOPS]: 'top',
  [GarmentCategory.BOTTOMS]: 'bottom',
  [GarmentCategory.DRESSES]: 'one-piece',
  [GarmentCategory.OUTERWEAR]: 'layer',
  [GarmentCategory.FOOTWEAR]: 'footwear',
  [GarmentCategory.ACCESSORIES]: 'accessory',
  [GarmentCategory.BAGS]: 'bag',
  [GarmentCategory.OTHER]: 'none',
};

/** The role of a stored (normalized) category. */
export function categoryRole(category: string): GarmentRole {
  return isBuiltInCategory(category) ? CATEGORY_ROLES[category] : 'none';
}

/**
 * The built-in categories whose garments play `role`: the inverse of
 * categoryRole, for queries that select a role (Styling's rows, #42). Every
 * custom category is `none` too, so a query for `none` is the categories
 * *not* built in for another role, not this list alone.
 */
export function builtInCategoriesOf(role: GarmentRole): GarmentCategory[] {
  return (Object.values(GarmentCategory) as GarmentCategory[]).filter(
    (category) => CATEGORY_ROLES[category] === role,
  );
}

// The value sets. Warmth and formality are ordered scales (smallint);
// the rest are words, stored as they are here.
export const WARMTHS = [1, 2, 3, 4, 5] as const;
export type Warmth = (typeof WARMTHS)[number];

export const FORMALITIES = [1, 2, 3, 4] as const;
export type Formality = (typeof FORMALITIES)[number];

export const MATERIALS = [
  'cotton',
  'linen',
  'wool',
  'merino',
  'cashmere',
  'silk',
  'denim',
  'leather',
  'suede',
  'polyester',
  'nylon',
  'fleece',
  'down',
  'knit',
  'synthetic',
  'other',
] as const;
export type Material = (typeof MATERIALS)[number];

export function isMaterial(value: string): value is Material {
  return (MATERIALS as readonly string[]).includes(value);
}

export const PATTERNS = [
  'solid',
  'stripes',
  'check',
  'print',
  'graphic',
  'floral',
  'other',
] as const;
export type Pattern = (typeof PATTERNS)[number];

export const FITS = ['slim', 'regular', 'relaxed', 'oversized'] as const;
export type Fit = (typeof FITS)[number];

export const SLEEVES = [
  'sleeveless',
  'short',
  'three-quarter',
  'long',
] as const;
export type Sleeve = (typeof SLEEVES)[number];

export const LENGTHS = ['short', 'knee', 'midi', 'full'] as const;
export type Length = (typeof LENGTHS)[number];

/**
 * What shape a garment is in: `needs_repair` (a hole, a torn loop; still in
 * the closet and still worn) or `replace_soon` (pilling, a collar gone).
 * Every role has it. It never feeds availability (src/wardrobe/availability.ts):
 * a worn-out tee is still wearable, and a garment physically at the tailor
 * is `away: repair` there, a different thing.
 */
export const CONDITIONS = ['good', 'needs_repair', 'replace_soon'] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * The only colours a garment may carry, in the order a colour set is stored
 * and shown. A garment's, a plan item's and a style profile's colours are
 * all text[] sets checked against this list (src/db/schema.ts), so adding
 * one is a migration. Each has a swatch class in views/assets/main.css
 * (`.ms-swatch--<name>`).
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

/**
 * A value set as every `text[]` set column stores it (garment.colors and
 * .materials, plan_item's, style_profile's): in `values`' order, each once,
 * anything outside `values` dropped, null for none (never an empty array).
 * Every writer of such a column goes through it: the garment form
 * (readColors, readProperties), bulk edit's "Set material", the plan and
 * style forms, "Bought it"'s fitted item.
 */
export function storedSet<T extends string>(
  values: readonly T[],
  chosen: readonly string[],
): T[] | null {
  const set = values.filter((value) => chosen.includes(value));
  return set.length > 0 ? set : null;
}

/**
 * Fabric weight is stored in grams per square metre (what most product
 * pages give, and an integer), entered and shown in ounces per square yard
 * too: a "6 oz heavyweight tee" is 203 gsm. Bounds reject typos, not
 * fabrics: a sheer silk is about 30 gsm, a melton coat about 800.
 */
export const FABRIC_WEIGHT_GSM = { min: 20, max: 1200 } as const;
export const GSM_PER_OZ = 33.906;

export function ozToGsm(oz: number): number {
  return Math.round(oz * GSM_PER_OZ);
}

/** Ounces to one decimal, as people write them ("6 oz", "5.5 oz"). */
export function gsmToOz(gsm: number): number {
  return Math.round((gsm / GSM_PER_OZ) * 10) / 10;
}

/** Every property a garment row can carry beyond the form's text fields. */
export const GARMENT_PROPERTIES = [
  'type',
  'warmth',
  'formality',
  'materials',
  'pattern',
  'fit',
  'sleeve',
  'length',
  'fabricWeight',
  'waterResistant',
  // The care label (care.ts, #23): one rule for all five.
  'careWash',
  'careBleach',
  'careDry',
  'careIron',
  'careDryClean',
] as const;
export type GarmentProperty = (typeof GARMENT_PROPERTIES)[number];

const ALL_ROLES = GARMENT_ROLES;
const WORN: readonly GarmentRole[] = ['top', 'bottom', 'one-piece', 'layer'];
// What is laundered and carries a care label: not shoes or bags.
const LABELLED: readonly GarmentRole[] = [...WORN, 'accessory', 'none'];

/**
 * Which roles each property applies to. The form shows only these, and a
 * save stores null for a property outside its garment's role (changing a
 * tee's category to bottoms drops its sleeve). `type` applies wherever the
 * category has types (typesOf), so custom categories never offer one.
 */
const APPLIES: Record<
  Exclude<GarmentProperty, 'type'>,
  readonly GarmentRole[]
> = {
  warmth: [...WORN, 'footwear', 'accessory', 'none'],
  formality: ALL_ROLES,
  materials: ALL_ROLES,
  pattern: [...WORN, 'accessory', 'bag', 'none'],
  fit: WORN,
  sleeve: ['top', 'one-piece'],
  length: ['bottom', 'one-piece'],
  fabricWeight: WORN,
  waterResistant: ['layer', 'footwear', 'accessory', 'bag'],
  careWash: LABELLED,
  careBleach: LABELLED,
  careDry: LABELLED,
  careIron: LABELLED,
  careDryClean: LABELLED,
};

export function propertyApplies(
  property: GarmentProperty,
  category: string,
): boolean {
  if (property === 'type') return typesOf(category).length > 0;
  return APPLIES[property].includes(categoryRole(category));
}

/** What choosing a type fills in (never over a value the user set). */
export interface Presets {
  warmth?: Warmth;
  formality?: Formality;
  sleeve?: Sleeve;
  length?: Length;
  waterResistant?: boolean;
}

/**
 * A heavier fabric of the same type is warmer: the first step whose
 * `minGsm` the garment's weight reaches replaces the type's warmth preset.
 * Listed heaviest first. A 6 oz (203 gsm) tee is warmth 3.
 */
export interface WeightStep {
  minGsm: number;
  warmth: Warmth;
}

export interface GarmentType {
  value: string;
  presets: Presets;
  weightSteps?: readonly WeightStep[];
}

// Tees and knits: heavyweight from 6 oz (200 gsm); a sheer tee under
// 4 oz (135 gsm) reads as very light.
const TEE_WEIGHTS: readonly WeightStep[] = [
  { minGsm: 200, warmth: 3 },
  { minGsm: 135, warmth: 2 },
  { minGsm: 0, warmth: 1 },
];
const FLEECE_WEIGHTS: readonly WeightStep[] = [
  { minGsm: 400, warmth: 4 },
  { minGsm: 0, warmth: 3 },
];
// Denim: 14 oz and up is heavy, under 10 oz is summer weight.
const DENIM_WEIGHTS: readonly WeightStep[] = [
  { minGsm: 475, warmth: 4 },
  { minGsm: 340, warmth: 3 },
  { minGsm: 0, warmth: 2 },
];

/**
 * The types of each built-in category, in the order the form offers them,
 * with their presets (docs/plans/2026-09-26-wardrobe-features.md, section
 * 6: a first cut, tuned on real garments). `other` has none.
 */
export const GARMENT_TYPES: Record<GarmentCategory, readonly GarmentType[]> = {
  [GarmentCategory.TOPS]: [
    {
      value: 't-shirt',
      presets: { warmth: 2, formality: 2, sleeve: 'short' },
      weightSteps: TEE_WEIGHTS,
    },
    {
      value: 'long-sleeve-tee',
      presets: { warmth: 2, formality: 2, sleeve: 'long' },
      weightSteps: TEE_WEIGHTS,
    },
    { value: 'shirt', presets: { warmth: 2, formality: 3, sleeve: 'long' } },
    { value: 'polo', presets: { warmth: 2, formality: 2, sleeve: 'short' } },
    { value: 'blouse', presets: { warmth: 2, formality: 3 } },
    {
      value: 'tank',
      presets: { warmth: 1, formality: 2, sleeve: 'sleeveless' },
    },
    { value: 'sweater', presets: { warmth: 4, formality: 3, sleeve: 'long' } },
    { value: 'cardigan', presets: { warmth: 3, formality: 3, sleeve: 'long' } },
    {
      value: 'hoodie',
      presets: { warmth: 3, formality: 1, sleeve: 'long' },
      weightSteps: FLEECE_WEIGHTS,
    },
    {
      value: 'sweatshirt',
      presets: { warmth: 3, formality: 1, sleeve: 'long' },
      weightSteps: FLEECE_WEIGHTS,
    },
    {
      value: 'turtleneck',
      presets: { warmth: 3, formality: 3, sleeve: 'long' },
    },
  ],
  [GarmentCategory.BOTTOMS]: [
    {
      value: 'jeans',
      presets: { warmth: 3, formality: 2, length: 'full' },
      weightSteps: DENIM_WEIGHTS,
    },
    { value: 'chinos', presets: { warmth: 2, formality: 3, length: 'full' } },
    { value: 'trousers', presets: { warmth: 2, formality: 3, length: 'full' } },
    { value: 'joggers', presets: { warmth: 3, formality: 1, length: 'full' } },
    {
      value: 'sweatpants',
      presets: { warmth: 3, formality: 1, length: 'full' },
    },
    { value: 'shorts', presets: { warmth: 1, formality: 2, length: 'short' } },
    { value: 'skirt', presets: { warmth: 2, formality: 3, length: 'knee' } },
    { value: 'leggings', presets: { warmth: 2, formality: 1, length: 'full' } },
  ],
  [GarmentCategory.DRESSES]: [
    { value: 'day-dress', presets: { warmth: 2, formality: 3 } },
    { value: 'evening-dress', presets: { warmth: 2, formality: 4 } },
    { value: 'jumpsuit', presets: { warmth: 2, formality: 3, length: 'full' } },
  ],
  [GarmentCategory.OUTERWEAR]: [
    { value: 'jacket', presets: { warmth: 3, formality: 2 } },
    { value: 'denim-jacket', presets: { warmth: 3, formality: 2 } },
    { value: 'leather-jacket', presets: { warmth: 3, formality: 3 } },
    { value: 'blazer', presets: { warmth: 2, formality: 4 } },
    { value: 'coat', presets: { warmth: 4, formality: 4 } },
    {
      value: 'parka',
      presets: { warmth: 5, formality: 2, waterResistant: true },
    },
    { value: 'puffer', presets: { warmth: 5, formality: 2 } },
    {
      value: 'trench',
      presets: { warmth: 3, formality: 4, waterResistant: true },
    },
    {
      value: 'rain-jacket',
      presets: { warmth: 2, formality: 2, waterResistant: true },
    },
    { value: 'vest', presets: { warmth: 3, formality: 2 } },
    { value: 'fleece', presets: { warmth: 3, formality: 1 } },
  ],
  [GarmentCategory.FOOTWEAR]: [
    { value: 'sneakers', presets: { warmth: 2, formality: 2 } },
    { value: 'running-shoes', presets: { warmth: 2, formality: 1 } },
    { value: 'boots', presets: { warmth: 4, formality: 3 } },
    { value: 'loafers', presets: { warmth: 2, formality: 3 } },
    { value: 'dress-shoes', presets: { warmth: 2, formality: 4 } },
    { value: 'sandals', presets: { warmth: 1, formality: 2 } },
    { value: 'slides', presets: { warmth: 1, formality: 1 } },
    { value: 'heels', presets: { warmth: 2, formality: 4 } },
  ],
  [GarmentCategory.ACCESSORIES]: [
    { value: 'hat', presets: {} },
    { value: 'cap', presets: { formality: 1 } },
    { value: 'beanie', presets: { warmth: 4, formality: 1 } },
    { value: 'scarf', presets: { warmth: 4 } },
    { value: 'gloves', presets: { warmth: 4 } },
    { value: 'belt', presets: {} },
    { value: 'sunglasses', presets: {} },
    { value: 'tie', presets: { formality: 4 } },
    { value: 'jewelry', presets: {} },
    { value: 'watch', presets: {} },
  ],
  [GarmentCategory.BAGS]: [
    { value: 'backpack', presets: { formality: 2 } },
    { value: 'tote', presets: { formality: 2 } },
    { value: 'crossbody', presets: { formality: 2 } },
    { value: 'handbag', presets: { formality: 3 } },
    { value: 'duffel', presets: { formality: 1 } },
  ],
  [GarmentCategory.OTHER]: [],
};

/** A category's types, in form order; none for `other` and custom categories. */
export function typesOf(category: string): readonly GarmentType[] {
  return isBuiltInCategory(category) ? GARMENT_TYPES[category] : [];
}

export function findType(
  category: string,
  type: string | null | undefined,
): GarmentType | undefined {
  return type ? typesOf(category).find((t) => t.value === type) : undefined;
}

/**
 * Every type of every category, each once: the check constraint's list. A
 * value may appear under two categories; which category a type belongs to
 * is the code's rule (findType), not the column's.
 */
export const ALL_GARMENT_TYPES: readonly string[] = [
  ...new Set(
    Object.values(GARMENT_TYPES).flatMap((types) => types.map((t) => t.value)),
  ),
];

/** The presets a (category, type, weight) implies; empty without a known type. */
export function presetsFor(source: PresetSource): Presets {
  const type = findType(source.category, source.type);
  if (!type) return {};
  const weight = source.fabricWeight;
  const step =
    weight === null
      ? undefined
      : type.weightSteps?.find((s) => weight >= s.minGsm);
  return step ? { ...type.presets, warmth: step.warmth } : type.presets;
}

/** What presets are computed from: the type as the form last had it, and its weight. */
export interface PresetSource {
  category: string;
  type: string | null;
  fabricWeight: number | null;
}

/** The properties presets fill, as stored (null for not set). */
export interface PresetValues {
  warmth: Warmth | null;
  formality: Formality | null;
  sleeve: Sleeve | null;
  length: Length | null;
  waterResistant: boolean;
}

/**
 * The values after the type (or weight) changed from `from` to `to`,
 * keeping every value the user chose. Stateless: a value the user did not
 * change still equals `from`'s preset (or is unset), so it follows the new
 * preset, cleared when the new type has none; anything else was chosen and
 * stays. The form carries `from` as hidden fields (the type and weight its
 * presets came from), so no request needs to know which fields were touched.
 * `waterResistant` false counts as unset: it is the column's default.
 */
export function applyPresets(
  current: PresetValues,
  from: PresetSource | null,
  to: PresetSource,
): PresetValues {
  const was = from ? presetsFor(from) : {};
  const now = presetsFor(to);
  return {
    warmth: followPreset(current.warmth, was.warmth, now.warmth),
    formality: followPreset(current.formality, was.formality, now.formality),
    sleeve: followPreset(current.sleeve, was.sleeve, now.sleeve),
    length: followPreset(current.length, was.length, now.length),
    waterResistant:
      followPreset(
        current.waterResistant || null,
        was.waterResistant || undefined,
        now.waterResistant || undefined,
      ) ?? false,
  };
}

/**
 * A value left unset or still at the old preset takes the new one. Also the
 * care label's rule (care.ts applyCarePresets, presets from the materials).
 */
export function followPreset<T>(
  value: T | null,
  was: T | undefined,
  now: T | undefined,
): T | null {
  return value === null || value === was ? (now ?? null) : value;
}
