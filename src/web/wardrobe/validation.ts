import { type Static, Type } from '@sinclair/typebox';
import type { FieldErrors } from '../auth/validation';
import { type IsoDate, parseIsoDate } from '../calendar/calendar-date';
import { t } from '../i18n';
import { RowId } from '../schemas';
import {
  NEVER_WASH,
  QUANTITY_MAX,
  WASH_AFTER_CHOICES,
} from '../../wardrobe/availability';
import {
  applyPresets,
  type Condition,
  CONDITIONS,
  FABRIC_WEIGHT_GSM,
  type Fit,
  FITS,
  type Formality,
  FORMALITIES,
  findType,
  GARMENT_COLORS,
  type GarmentProperty,
  gsmToOz,
  isGarmentColor,
  type Length,
  LENGTHS,
  type Material,
  MATERIALS,
  ozToGsm,
  type Pattern,
  PATTERNS,
  type PresetSource,
  propertyApplies,
  type Sleeve,
  SLEEVES,
  type Warmth,
  WARMTHS,
} from '../../wardrobe/properties';
import { normalizeCategory, normalizeSize } from './garment';

/**
 * The wardrobe's request schemas and the garment form's checks. Two layers,
 * as in src/web/auth/validation.ts: the TypeBox schemas are the routes'
 * Fastify schemas (a body or query that is not the form's shape, or longer
 * than a field allows, never reaches the handler: a 400 error page), and
 * readGarmentForm checks what a well-formed form can still get wrong (a
 * blank category, a colour outside GARMENT_COLORS, a date that is not one),
 * which re-renders the form with a 400 and the messages under the fields.
 * The inputs carry the same maxlength, so a person never meets the caps.
 */

export const NAME_MAX = 200;
export const CATEGORY_MAX = 60;
export const BRAND_MAX = 100;
export const SIZE_MAX = 40;
export const TEXT_MAX = 4000;
/** Product pages' URLs run long (tracking parameters); browsers take ~2k. */
export const SOURCE_URL_MAX = 2048;
/** "$12,345,678.90" and a little room: numeric(10, 2) holds 8 digits before the point. */
export const PRICE_INPUT_MAX = 20;
/** "Hole in the left elbow", "At the cobbler on Fulton St": a line, not a story. */
export const CARE_NOTE_MAX = 200;

// Room for a hostile value to reach readGarmentForm and be named in its
// message; every real colour is a few letters.
const ColorValue = Type.String({ maxLength: 40 });

/**
 * One of a property's values as a form posts it ('' for the reset chip).
 * Only the form's own chips post these, so anything else is a hand-made
 * request: a 400 from the schema, not a message under a field. Also the
 * plan item form's scales (src/web/plans/validation.ts).
 */
export function choice(values: readonly (string | number)[]) {
  return Type.Optional(
    Type.Union([
      Type.Literal(''),
      ...values.map((value) => Type.Literal(String(value))),
    ]),
  );
}

export const FabricWeightUnit = Type.Union([
  Type.Literal('oz'),
  Type.Literal('gsm'),
]);
export type FabricWeightUnit = Static<typeof FabricWeightUnit>;

/**
 * The property fields as the form posts them; shared by the garment form's
 * body and the properties fragment's query. A type is checked against the
 * posted category in readProperties (it is a free choice of the category's
 * list, which the schema cannot see).
 */
export const PropertyFields = {
  type: Type.Optional(Type.String({ maxLength: 40 })),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
  materials: Type.Optional(
    Type.Array(
      Type.Union(MATERIALS.map((material) => Type.Literal(material))),
      { maxItems: MATERIALS.length * 2 },
    ),
  ),
  pattern: choice(PATTERNS),
  fit: choice(FITS),
  sleeve: choice(SLEEVES),
  length: choice(LENGTHS),
  fabricWeight: Type.Optional(Type.String({ maxLength: 12 })),
  fabricWeightUnit: Type.Optional(FabricWeightUnit),
  waterResistant: Type.Optional(Type.Literal('true')),
  // Hidden: the category, type and weight (gsm) the shown presets came
  // from, so a type change replaces only values still at their preset
  // (applyPresets, src/wardrobe/properties.ts). Never stored.
  presetCategory: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  presetType: Type.Optional(Type.String({ maxLength: 40 })),
  presetWeight: Type.Optional(Type.String({ maxLength: 12 })),
};
const PostedProperties = Type.Object(PropertyFields);
type PostedProperties = Static<typeof PostedProperties>;

const ConditionValue = Type.Union(
  CONDITIONS.map((condition) => Type.Literal(condition)),
);

/** A condition and what is wrong, as the form and the garment page post them. */
const PostedConditionFields = {
  condition: Type.Optional(ConditionValue),
  conditionNote: Type.Optional(Type.String({ maxLength: CARE_NOTE_MAX })),
};

/**
 * The care fields (#7): identical copies, wears before a wash ('' the
 * role's default, NEVER_WASH never) and the condition. Quantity is typed,
 * so it is the one with a message (readCareFields); the rest are choices.
 */
const PostedCareFields = {
  quantity: Type.Optional(Type.String({ maxLength: 6 })),
  washAfterWears: choice([NEVER_WASH, ...WASH_AFTER_CHOICES]),
  ...PostedConditionFields,
};

/** POST /wardrobe/:id/condition: the garment page's condition control. */
export const ConditionBody = Type.Object(PostedConditionFields);
export type ConditionBody = Static<typeof ConditionBody>;

/** Where a new garment lands (EntryStatus, src/wardrobe/status.ts). */
export const Destination = Type.Union([
  Type.Literal('closet'),
  Type.Literal('wishlist'),
]);

/**
 * One garment form post (new, edit, clone). The form posts every text field,
 * '' when left empty; `color` is one value per checked box (none when no box
 * is checked; ajv's coerceTypes 'array' makes a single one a list).
 * `dateAquired` keeps the form's historical field name (cached pages of the
 * installed app still post it); it is stored as garment.acquired_on.
 */
export const GarmentBody = Type.Object({
  name: Type.Optional(Type.String({ maxLength: NAME_MAX })),
  category: Type.String({ maxLength: CATEGORY_MAX }),
  brand: Type.Optional(Type.String({ maxLength: BRAND_MAX })),
  color: Type.Optional(
    Type.Array(ColorValue, { maxItems: GARMENT_COLORS.length * 2 }),
  ),
  size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
  washingDetails: Type.Optional(Type.String({ maxLength: TEXT_MAX })),
  dateAquired: Type.Optional(Type.String({ maxLength: 32 })),
  notes: Type.Optional(Type.String({ maxLength: TEXT_MAX })),
  ...PropertyFields,
  // '1' from every form that renders the properties. A form the installed
  // app cached before they existed posts none, and its save must leave the
  // stored ones alone rather than clear them (an edit writes every field).
  props: Type.Optional(Type.Literal('1')),
  sourceUrl: Type.Optional(Type.String({ maxLength: SOURCE_URL_MAX })),
  price: Type.Optional(Type.String({ maxLength: PRICE_INPUT_MAX })),
  // '1' from every form that renders the product link and price, for the
  // same reason as props: forms cached before them (props=1 included) post
  // neither, and must not clear them.
  product: Type.Optional(Type.Literal('1')),
  // A new garment's form prefilled from a link: the stored name of the
  // photo fetched with it, claimed on save (POST /wardrobe only; judged by
  // parseStoredName there, the one definition of a stored name).
  linkPhoto: Type.Optional(Type.String({ maxLength: 64 })),
  ...PostedCareFields,
  // '1' from every form that renders the care fields: forms cached before
  // them post none, and must not reset a garment to one copy in good shape.
  care: Type.Optional(Type.Literal('1')),
  // A new garment's destination (the wishlist's "Add" and "Find a
  // replacement"); absent is the closet, as every form before #18 posts.
  to: Type.Optional(Destination),
  // What a wishlist item replaces ('' for nothing), read only beside its
  // marker `wishlist=1`: the wishlist forms render both, and every other
  // form (a closet garment's, one cached before #18) must leave it alone.
  replaces: Type.Optional(Type.Union([Type.Literal(''), RowId])),
  wishlist: Type.Optional(Type.Literal('1')),
});
export type GarmentBody = Static<typeof GarmentBody>;

/** What the form shows: the posted strings, or a stored garment's. */
export interface GarmentFormValues {
  name: string;
  category: string;
  brand: string;
  colors: string[];
  size: string;
  washingDetails: string;
  dateAquired: string;
  notes: string;
  sourceUrl: string;
  price: string;
  properties: PropertyFormValues;
  care: CareFormValues;
  /** A wishlist item's replaced garment id, '' for none. */
  replaces: string;
}

/** The care fields as the form shows them (strings as posted). */
export interface CareFormValues {
  quantity: string;
  washAfterWears: string;
  condition: Condition;
  conditionNote: string;
}

export const BLANK_CARE: CareFormValues = {
  quantity: '1',
  washAfterWears: '',
  condition: 'good',
  conditionNote: '',
};

/** The property fields as the form shows them (strings as posted). */
export interface PropertyFormValues {
  type: string;
  warmth: string;
  formality: string;
  materials: string[];
  pattern: string;
  fit: string;
  sleeve: string;
  length: string;
  /** As typed, in `fabricWeightUnit`. */
  fabricWeight: string;
  fabricWeightUnit: FabricWeightUnit;
  waterResistant: boolean;
  /** Where the shown presets came from (hidden fields; see PropertyFields). */
  preset: { category: string; type: string; weight: string };
}

export const BLANK_PROPERTIES: PropertyFormValues = {
  type: '',
  warmth: '',
  formality: '',
  materials: [],
  pattern: '',
  fit: '',
  sleeve: '',
  length: '',
  fabricWeight: '',
  fabricWeightUnit: 'oz',
  waterResistant: false,
  preset: { category: '', type: '', weight: '' },
};

/** A new garment's form: every field empty. */
export const BLANK_GARMENT_VALUES: GarmentFormValues = {
  name: '',
  category: '',
  brand: '',
  colors: [],
  size: '',
  washingDetails: '',
  dateAquired: '',
  notes: '',
  sourceUrl: '',
  price: '',
  properties: BLANK_PROPERTIES,
  care: BLANK_CARE,
  replaces: '',
};

export type GarmentField =
  | 'category'
  | 'color'
  | 'dateAquired'
  | 'fabricWeight'
  | 'sourceUrl'
  | 'price'
  | 'linkPhoto'
  | 'quantity';

/** The properties as stored (null for not set, or not applying to the role). */
export interface GarmentPropertyFields {
  type: string | null;
  warmth: Warmth | null;
  formality: Formality | null;
  materials: Material[] | null;
  pattern: Pattern | null;
  fit: Fit | null;
  sleeve: Sleeve | null;
  length: Length | null;
  /** Grams per square metre. */
  fabricWeight: number | null;
  waterResistant: boolean;
}

/** Where the garment can be bought and what it cost, as stored. */
export interface ProductFields {
  /** An http(s) URL (readSourceUrl). */
  sourceUrl: string | null;
  /** numeric(10, 2) as text, always two decimals ('24.90'). */
  price: string | null;
}

/** A garment's condition as stored: the note only with a problem. */
export interface ConditionFields {
  condition: Condition;
  conditionNote: string | null;
}

/** Copies, wash limit and condition, as stored. */
export interface CareFields extends ConditionFields {
  /** 1 to QUANTITY_MAX. */
  quantity: number;
  /** null: the role's default; NEVER_WASH: never. */
  washAfterWears: number | null;
}

/**
 * A garment's fields as stored: trimmed, null when blank. The properties,
 * the product fields and the care fields are absent (left as stored) when
 * the posting form predates them.
 */
export interface GarmentFields
  extends
    Partial<GarmentPropertyFields>,
    Partial<ProductFields>,
    Partial<CareFields> {
  name: string | null;
  category: string;
  brand: string | null;
  /** Comma-joined GARMENT_COLORS, in the form's order; null for none. */
  color: string | null;
  size: string | null;
  notes: string | null;
  washingDetails: string | null;
  acquiredOn: IsoDate | null;
  /**
   * The garment a wishlist item replaces (null for none); absent (left as
   * stored) unless the form was a wishlist form (GarmentBody.wishlist).
   * Stored only when it is the same owner's (replacementOf, queries.ts).
   */
  replacesGarmentId?: number | null;
}

export type GarmentForm =
  | { ok: true; fields: GarmentFields }
  | { ok: false; values: GarmentFormValues; errors: FieldErrors<GarmentField> };

/** One-line fields: trimmed, and null when blank. */
function line(value: string | undefined): string | null {
  return value?.trim() || null;
}

/** Multi-line text: kept as typed, null when blank. */
function text(value: string | undefined): string | null {
  return value?.trim() ? value : null;
}

export function formValues(body: GarmentBody): GarmentFormValues {
  return {
    name: body.name ?? '',
    category: body.category,
    brand: body.brand ?? '',
    colors: body.color ?? [],
    size: body.size ?? '',
    washingDetails: body.washingDetails ?? '',
    dateAquired: body.dateAquired ?? '',
    notes: body.notes ?? '',
    sourceUrl: body.sourceUrl ?? '',
    price: body.price ?? '',
    properties: propertyFormValues(body),
    care: careFormValues(body),
    replaces: replacesShown(body.replaces),
  };
}

/**
 * What the garment form posts when it shows `values` (formValues'
 * inverse), every marker set: for a writer that has form values but no
 * browser, so its garment goes through readGarmentForm like any other
 * (the MCP tool add_garment_from_link, which saves a link import's
 * prefilled form). The caller's values stay bounded by GarmentBody's
 * caps; readGarmentForm judges the rest.
 */
export function formPost(values: GarmentFormValues): GarmentBody {
  const { properties, care } = values;
  return {
    name: values.name,
    category: values.category,
    brand: values.brand,
    color: values.colors,
    size: values.size,
    washingDetails: values.washingDetails,
    dateAquired: values.dateAquired,
    notes: values.notes,
    props: '1',
    type: properties.type,
    warmth: choiceValue(WARMTHS, properties.warmth),
    formality: choiceValue(FORMALITIES, properties.formality),
    materials: MATERIALS.filter((m) => properties.materials.includes(m)),
    pattern: choiceValue(PATTERNS, properties.pattern),
    fit: choiceValue(FITS, properties.fit),
    sleeve: choiceValue(SLEEVES, properties.sleeve),
    length: choiceValue(LENGTHS, properties.length),
    fabricWeight: properties.fabricWeight,
    fabricWeightUnit: properties.fabricWeightUnit,
    ...(properties.waterResistant && { waterResistant: 'true' }),
    product: '1',
    sourceUrl: values.sourceUrl,
    price: values.price,
    care: '1',
    wishlist: '1',
    replaces: values.replaces === '' ? '' : Number(values.replaces),
    quantity: care.quantity,
    washAfterWears: choiceValue(
      [NEVER_WASH, ...WASH_AFTER_CHOICES],
      care.washAfterWears,
    ),
    condition: care.condition,
    conditionNote: care.conditionNote,
  };
}

/**
 * A choice field's text as the schema types it: one of `set` (as text), or
 * '' (the reset chip) for anything else.
 */
function choiceValue<T extends string | number>(
  set: readonly T[],
  shown: string,
): `${T}` | '' {
  const found = pick(set, shown);
  return found === null ? '' : (String(found) as `${T}`);
}

/** A wishlist form's posted "Replaces" as the form shows it ('' for nothing). */
function replacesShown(posted: GarmentBody['replaces']): string {
  return posted === undefined ? '' : String(posted);
}

/** The posted care fields as the form shows them; a new garment's without them. */
function careFormValues(body: GarmentBody): CareFormValues {
  if (body.care !== '1') return BLANK_CARE;
  return {
    quantity: body.quantity ?? '',
    washAfterWears: body.washAfterWears ?? '',
    condition: body.condition ?? 'good',
    conditionNote: body.conditionNote ?? '',
  };
}

/** A stored garment's care fields as the form shows them. */
export function storedCareValues(stored: CareFields): CareFormValues {
  return {
    quantity: String(stored.quantity),
    washAfterWears: asText(stored.washAfterWears),
    condition: stored.condition,
    conditionNote: orEmpty(stored.conditionNote),
  };
}

/**
 * The condition as stored: the note trimmed, and only with a problem (a
 * garment in good shape has nothing to note; the column's check agrees).
 */
export function readCondition(posted: {
  condition?: Condition;
  conditionNote?: string;
}): ConditionFields {
  const condition = posted.condition ?? 'good';
  return {
    condition,
    conditionNote: condition === 'good' ? null : line(posted.conditionNote),
  };
}

/**
 * The care fields as stored, or the quantity's message; none (left as
 * stored) when the posting form predates them (GarmentBody.care). A blank
 * quantity is one copy.
 */
export function readCareFields(
  posted: Pick<
    GarmentBody,
    'care' | 'quantity' | 'washAfterWears' | 'condition' | 'conditionNote'
  >,
): { ok: true; fields: Partial<CareFields> } | { ok: false; error: string } {
  if (posted.care !== '1') return { ok: true, fields: {} };
  const typed = posted.quantity?.trim() || '1';
  const quantity = Number(typed);
  if (!/^\d+$/.test(typed) || quantity < 1 || quantity > QUANTITY_MAX) {
    return {
      ok: false,
      error: t('validation.QUANTITY_RANGE', { max: QUANTITY_MAX }),
    };
  }
  return {
    ok: true,
    fields: {
      quantity,
      washAfterWears: pick(
        [NEVER_WASH, ...WASH_AFTER_CHOICES],
        posted.washAfterWears ?? '',
      ),
      ...readCondition(posted),
    },
  };
}

/** The posted property fields as the form shows them. */
export function propertyFormValues(
  posted: PostedProperties,
): PropertyFormValues {
  return {
    type: orEmpty(posted.type),
    warmth: orEmpty(posted.warmth),
    formality: orEmpty(posted.formality),
    materials: posted.materials ?? [],
    pattern: orEmpty(posted.pattern),
    fit: orEmpty(posted.fit),
    sleeve: orEmpty(posted.sleeve),
    length: orEmpty(posted.length),
    fabricWeight: orEmpty(posted.fabricWeight),
    fabricWeightUnit: posted.fabricWeightUnit ?? 'oz',
    waterResistant: posted.waterResistant === 'true',
    preset: {
      category: orEmpty(posted.presetCategory),
      type: orEmpty(posted.presetType),
      weight: orEmpty(posted.presetWeight),
    },
  };
}

/** A stored garment's properties as the form shows them (weight in oz). */
export function storedPropertyValues(
  stored: GarmentPropertyFields & { category: string },
): PropertyFormValues {
  return {
    type: orEmpty(stored.type),
    warmth: asText(stored.warmth),
    formality: asText(stored.formality),
    materials: stored.materials ?? [],
    pattern: orEmpty(stored.pattern),
    fit: orEmpty(stored.fit),
    sleeve: orEmpty(stored.sleeve),
    length: orEmpty(stored.length),
    fabricWeight: asText(stored.fabricWeight, gsmToOz),
    fabricWeightUnit: 'oz',
    waterResistant: stored.waterResistant,
    // The stored values that still equal the stored type's presets follow
    // a type change; the rest were chosen.
    preset: {
      category: stored.category,
      type: orEmpty(stored.type),
      weight: asText(stored.fabricWeight),
    },
  };
}

/** A form field's text for an optional value: '' for none. */
function orEmpty(value: string | null | undefined): string {
  return value ?? '';
}

/** A number as a form field's text, through `show` (e.g. gsm to oz); '' for none. */
function asText(
  value: number | null,
  show: (value: number) => number = (n) => n,
): string {
  return value === null ? '' : String(show(value));
}

/**
 * A typed weight in grams per square metre: null when empty, a message
 * when it is not a number or outside FABRIC_WEIGHT_GSM (named in the unit
 * the person typed).
 */
export function readFabricWeight(
  posted: string,
  unit: FabricWeightUnit,
): { gsm: number | null } | { error: string } {
  const typed = posted.trim();
  if (!typed) return { gsm: null };
  const value = Number(typed.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    return { error: t('validation.FABRIC_WEIGHT_NUMBER') };
  }
  const gsm = unit === 'gsm' ? Math.round(value) : ozToGsm(value);
  if (gsm < FABRIC_WEIGHT_GSM.min || gsm > FABRIC_WEIGHT_GSM.max) {
    const [min, max] =
      unit === 'gsm'
        ? [FABRIC_WEIGHT_GSM.min, FABRIC_WEIGHT_GSM.max]
        : [gsmToOz(FABRIC_WEIGHT_GSM.min), gsmToOz(FABRIC_WEIGHT_GSM.max)];
    return {
      error: t('validation.FABRIC_WEIGHT_RANGE', {
        min,
        max,
        unit: t(unit === 'gsm' ? 'UNIT_GSM' : 'UNIT_OZ'),
      }),
    };
  }
  return { gsm };
}

/**
 * The posted properties as stored for a garment of `category`: a type
 * outside the category's list and every property its role does not have
 * are null (so recategorising a tee as shorts drops its sleeve), and
 * materials are a set, null for none. The weight is the only field a
 * person types, so the only one with a message.
 */
export function readProperties(
  values: PropertyFormValues,
  category: string,
): { ok: true; fields: GarmentPropertyFields } | { ok: false; error: string } {
  const weight = readFabricWeight(values.fabricWeight, values.fabricWeightUnit);
  if ('error' in weight) return { ok: false, error: weight.error };
  /** `value` when the category's role has `property`, else not set. */
  const only = <T>(property: GarmentProperty, value: T | null): T | null =>
    propertyApplies(property, category) ? value : null;
  // In MATERIALS order, each once; none is null, never an empty array.
  const materials = MATERIALS.filter((m) => values.materials.includes(m));
  return {
    ok: true,
    fields: {
      type: findType(category, values.type)?.value ?? null,
      warmth: only('warmth', pick(WARMTHS, values.warmth)),
      formality: only('formality', pick(FORMALITIES, values.formality)),
      materials: only('materials', materials.length > 0 ? materials : null),
      pattern: only('pattern', pick(PATTERNS, values.pattern)),
      fit: only('fit', pick(FITS, values.fit)),
      sleeve: only('sleeve', pick(SLEEVES, values.sleeve)),
      length: only('length', pick(LENGTHS, values.length)),
      fabricWeight: only('fabricWeight', weight.gsm),
      waterResistant: only('waterResistant', values.waterResistant) === true,
    },
  };
}

/**
 * The form's properties after the category, type or weight changed (the
 * properties fragment): a type outside the category is dropped, values
 * still at the previous presets follow the new ones (applyPresets), and
 * the hidden preset fields move to what the presets now come from. An
 * unreadable weight counts as none here; the save names it.
 */
export function withPresets(
  values: PropertyFormValues,
  category: string,
): PropertyFormValues {
  const type = findType(category, values.type)?.value ?? null;
  const weight = readFabricWeight(values.fabricWeight, values.fabricWeightUnit);
  const gsm = 'gsm' in weight ? weight.gsm : null;
  const next = applyPresets(
    {
      warmth: pick(WARMTHS, values.warmth),
      formality: pick(FORMALITIES, values.formality),
      sleeve: pick(SLEEVES, values.sleeve),
      length: pick(LENGTHS, values.length),
      waterResistant: values.waterResistant,
    },
    presetSource(values.preset),
    { category, type, fabricWeight: gsm },
  );
  return {
    ...values,
    type: orEmpty(type),
    warmth: asText(next.warmth),
    formality: asText(next.formality),
    sleeve: orEmpty(next.sleeve),
    length: orEmpty(next.length),
    waterResistant: next.waterResistant,
    preset: { category, type: orEmpty(type), weight: asText(gsm) },
  };
}

/** The hidden preset fields as applyPresets reads them; null before any. */
function presetSource(
  preset: PropertyFormValues['preset'],
): PresetSource | null {
  if (!preset.category) return null;
  const gsm = Number(preset.weight);
  return {
    category: normalizeCategory(preset.category),
    type: preset.type || null,
    fabricWeight: preset.weight && Number.isInteger(gsm) ? gsm : null,
  };
}

/** The member of `set` a form or query posted; '' (the reset chip) is none. */
export function pick<T extends string | number>(
  set: readonly T[],
  posted: string,
): T | null {
  return set.find((value) => String(value) === posted) ?? null;
}

/** The posted colours without repeats, and the messages for any not built in. */
function readColors(posted: string[] = []): {
  colors: string[];
  errors: string[];
} {
  const colors = [...new Set(posted)];
  return {
    colors,
    errors: colors
      .filter((color) => !isGarmentColor(color))
      .map((color) => t('validation.UNKNOWN_COLOR', { color })),
  };
}

/** The date input's value: null when empty, undefined when not a real date. */
function readDay(posted: string | undefined): IsoDate | null | undefined {
  const value = posted?.trim();
  return value ? parseIsoDate(value) : null;
}

/**
 * A product page's address as stored: the URL as the parser writes it, or
 * null when blank; a message for anything that is not an absolute http(s)
 * URL (a `javascript:` link would run on the garment page's "View product").
 */
export function readSourceUrl(
  posted: string | undefined,
): { url: string | null } | { error: string } {
  const typed = posted?.trim();
  if (!typed) return { url: null };
  const url = URL.parse(typed);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return { error: t('validation.SOURCE_URL_INVALID') };
  }
  return { url: url.href };
}

// Dollars and cents as people type them ("49.9", "$1,299.00"): the symbol
// and thousands separators are dropped, then at most 8 digits before the
// point (numeric(10, 2)) and 2 after. No sign: a price is never negative.
const PRICE = /^(\d{1,8})(?:\.(\d{1,2}))?$/;

/** A typed price as stored ('49.90'), null when blank, or a message. */
export function readPrice(
  posted: string | undefined,
): { price: string | null } | { error: string } {
  const typed = posted
    ?.trim()
    .replace(/^\$\s*/, '')
    .replaceAll(',', '');
  if (!typed) return { price: null };
  const match = PRICE.exec(typed);
  if (!match) return { error: t('validation.PRICE_INVALID') };
  const [, whole, cents = ''] = match;
  return { price: `${Number(whole)}.${cents.padEnd(2, '0')}` };
}

/**
 * The product link and price as stored, or the messages for them; neither
 * (left as stored) when the posting form predates them (GarmentBody.product).
 */
export function readProductFields(
  posted: Pick<GarmentBody, 'product' | 'sourceUrl' | 'price'>,
):
  | { ok: true; fields: Partial<ProductFields> }
  | { ok: false; errors: FieldErrors<'sourceUrl' | 'price'> } {
  if (posted.product !== '1') return { ok: true, fields: {} };
  const sourceUrl = readSourceUrl(posted.sourceUrl);
  const price = readPrice(posted.price);
  if ('url' in sourceUrl && 'price' in price) {
    return {
      ok: true,
      fields: { sourceUrl: sourceUrl.url, price: price.price },
    };
  }
  return {
    ok: false,
    errors: {
      ...('error' in sourceUrl && { sourceUrl: [sourceUrl.error] }),
      ...('error' in price && { price: [price.error] }),
    },
  };
}

/**
 * The posted properties as stored for `category`; none (left as stored)
 * when the posting form predates them (GarmentBody.props).
 */
function readPostedProperties(
  body: GarmentBody,
  category: string,
): ReturnType<typeof readProperties> | undefined {
  return body.props === '1'
    ? readProperties(propertyFormValues(body), category)
    : undefined;
}

/** The posted form as the garment to store, or what to show the person. */
export function readGarmentForm(body: GarmentBody): GarmentForm {
  const category = normalizeCategory(body.category);
  const colors = readColors(body.color);
  const acquiredOn = readDay(body.dateAquired);
  const properties = readPostedProperties(body, category);
  const product = readProductFields(body);
  const care = readCareFields(body);
  const errors = formErrors({
    category,
    colors,
    acquiredOn,
    properties,
    product,
    care,
  });
  // (The date check repeats formErrors' to narrow acquiredOn for the store.)
  if (Object.keys(errors).length > 0 || acquiredOn === undefined) {
    return { ok: false, values: formValues(body), errors };
  }
  return {
    ok: true,
    fields: {
      ...(properties?.ok ? properties.fields : {}),
      ...(product.ok && product.fields),
      ...(care.ok && care.fields),
      ...readReplaces(body),
      name: line(body.name),
      category,
      brand: line(body.brand),
      color: colors.colors.length > 0 ? colors.colors.join(',') : null,
      size: normalizeSize(body.size ?? '') ?? null,
      notes: text(body.notes),
      washingDetails: text(body.washingDetails),
      acquiredOn,
    },
  };
}

/**
 * What a wishlist item replaces (null for nothing); nothing (left as
 * stored) unless the form was a wishlist form (GarmentBody.wishlist).
 */
function readReplaces(
  body: Pick<GarmentBody, 'wishlist' | 'replaces'>,
): Pick<GarmentFields, 'replacesGarmentId'> {
  return body.wishlist === '1'
    ? { replacesGarmentId: body.replaces || null }
    : {};
}

/** The messages for what a well-formed garment form can still get wrong. */
function formErrors(read: {
  category: string;
  colors: { errors: string[] };
  acquiredOn: IsoDate | null | undefined;
  properties: ReturnType<typeof readProperties> | undefined;
  product: ReturnType<typeof readProductFields>;
  care: ReturnType<typeof readCareFields>;
}): FieldErrors<GarmentField> {
  const errors: FieldErrors<GarmentField> = read.product.ok
    ? {}
    : { ...read.product.errors };
  if (!read.category) errors.category = [t('validation.CATEGORY_REQUIRED')];
  if (read.colors.errors.length > 0) errors.color = read.colors.errors;
  if (read.acquiredOn === undefined) {
    errors.dateAquired = [t('validation.INVALID_DATE')];
  }
  if (read.properties?.ok === false) {
    errors.fabricWeight = [read.properties.error];
  }
  if (!read.care.ok) errors.quantity = [read.care.error];
  return errors;
}

/**
 * `?ownerId=`: the wardrobe a request addresses, the requester's own when
 * absent or empty (the pages only add it for a shared wardrobe). Anything
 * else is a 400: it names whose data to read.
 */
export const OwnerQuery = Type.Object({
  ownerId: Type.Optional(Type.Union([Type.Literal(''), RowId])),
});

export const GarmentParams = Type.Object({ id: RowId });

// The grid's filters are navigation state from its own links, the search
// form and the filter modal. A colour outside GARMENT_COLORS is a 400: it is
// matched inside the stored list and must be one of its items.
const GridFilters = {
  keyword: Type.Optional(Type.String({ maxLength: 200 })),
  category: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  color: Type.Optional(
    Type.Union([
      Type.Literal(''),
      ...GARMENT_COLORS.map((color) => Type.Literal(color)),
    ]),
  ),
  size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
  // A type outside the chosen category is dropped (gridSearch); the scales
  // and the material are matched as stored values, so outside their sets
  // they are a 400 like a colour.
  type: Type.Optional(Type.String({ maxLength: 40 })),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
  material: Type.Optional(
    Type.Union([
      Type.Literal(''),
      ...MATERIALS.map((material) => Type.Literal(material)),
    ]),
  ),
  archived: Type.Optional(Type.String({ maxLength: 10 })),
  // 'true' filters, like archived: garments with a copy that needs a wash
  // (the owner's own wardrobe only: a share never reveals wears; gridSearch
  // drops it), and those whose condition is not good.
  needsWash: Type.Optional(Type.String({ maxLength: 10 })),
  attention: Type.Optional(Type.String({ maxLength: 10 })),
  // A capsule of the addressed wardrobe (src/web/capsules): a 400 when not
  // an id, a 404 when not one of the wardrobe's capsules (the route).
  capsule: Type.Optional(Type.Union([Type.Literal(''), RowId])),
};

export const GridQuery = Type.Object({
  ...OwnerQuery.properties,
  ...GridFilters,
  // Select mode: tiles are checkboxes of the bulk form. Navigation state.
  select: Type.Optional(Type.String({ maxLength: 5 })),
  // The capsule picker: select mode whose checkboxes are this capsule's
  // membership (POST /capsules/:id/garments). Owner and MANAGE only.
  pick: Type.Optional(RowId),
  // One-shot flags from POST /wardrobe/bulk's redirect (the toast).
  bulkUpdated: Type.Optional(Type.Integer({ minimum: 0 })),
  bulkSkipped: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type GridQuery = Static<typeof GridQuery>;

/** The "load more" sentinel's request: the same filters, and where the last page ended. */
export const TilesQuery = Type.Object({
  ...GridQuery.properties,
  before: RowId,
});

/** The page flags that show a toast once (stripped from the URL by the page). */
export const GarmentPageQuery = Type.Object({
  ...OwnerQuery.properties,
  created: Type.Optional(Type.String()),
  photoSaved: Type.Optional(Type.String()),
  bought: Type.Optional(Type.String()),
});

/**
 * Where a new garment's form and the link import land: `?to=wishlist` from
 * the wishlist, and `&replaces=<id>` from a garment's "Find a replacement"
 * (a garment of the addressed wardrobe, else a 404). Absent is the closet.
 */
export const DestinationQuery = Type.Object({
  ...OwnerQuery.properties,
  to: Type.Optional(Type.Union([Type.Literal(''), Destination])),
  replaces: Type.Optional(Type.Union([Type.Literal(''), RowId])),
});
export type DestinationQuery = Static<typeof DestinationQuery>;

/**
 * GET /wardrobe/properties-fragment: the form's category and property
 * fields, as the category input, a type chip or the weight sends them
 * (hx-include). Malformed values are a 400 like the form's own.
 */
export const PropertiesFragmentQuery = Type.Object({
  category: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  ...PropertyFields,
});

/** The properties bulk edit can set: not type or weight, which are per garment. */
export const BULK_PROPERTIES = [
  'warmth',
  'formality',
  'materials',
  'pattern',
  'fit',
  'sleeve',
  'length',
  'waterResistant',
  'condition',
] as const;
export type BulkProperty = (typeof BULK_PROPERTIES)[number];

/**
 * POST /wardrobe/bulk: the selected tiles' ids (none is a no-op), the
 * property (the dialog's tab), and that property's value field, as the
 * garment form names it. The other tabs' fields may ride along and are
 * ignored. '' clears a property; materials add `material`.
 */
export const BulkBody = Type.Object({
  ids: Type.Optional(Type.Array(RowId, { maxItems: 2000 })),
  property: Type.Union(BULK_PROPERTIES.map((name) => Type.Literal(name))),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
  material: Type.Optional(
    Type.Union(MATERIALS.map((material) => Type.Literal(material))),
  ),
  pattern: choice(PATTERNS),
  fit: choice(FITS),
  sleeve: choice(SLEEVES),
  length: choice(LENGTHS),
  waterResistant: Type.Optional(
    Type.Union([Type.Literal('true'), Type.Literal('false')]),
  ),
  // Never cleared: 'good' is the reset.
  condition: Type.Optional(ConditionValue),
});
export type BulkBody = Static<typeof BulkBody>;

/** One property's new value for every selected garment (bulkSetProperty). */
export type BulkChange =
  | { property: 'warmth'; value: Warmth | null }
  | { property: 'formality'; value: Formality | null }
  | { property: 'materials'; value: Material }
  | { property: 'pattern'; value: Pattern | null }
  | { property: 'fit'; value: Fit | null }
  | { property: 'sleeve'; value: Sleeve | null }
  | { property: 'length'; value: Length | null }
  | { property: 'waterResistant'; value: boolean }
  | { property: 'condition'; value: Condition };

// The field each bulk property's chips post.
const BULK_FIELDS: Record<BulkProperty, keyof BulkBody> = {
  warmth: 'warmth',
  formality: 'formality',
  materials: 'material',
  pattern: 'pattern',
  fit: 'fit',
  sleeve: 'sleeve',
  length: 'length',
  waterResistant: 'waterResistant',
  condition: 'condition',
};

/**
 * The change a bulk post asks for, or undefined when the chosen tab's
 * chips were left alone. A radio group with nothing picked posts no key at
 * all, which is not the "Not set" chip (the key with ''): reading the two
 * alike would clear the property on every selected garment when someone
 * switched tabs and tapped Apply without choosing.
 */
export function readBulkChange(body: BulkBody): BulkChange | undefined {
  return body[BULK_FIELDS[body.property]] === undefined
    ? undefined
    : bulkChangeOf(body);
}

/** The chosen tab's posted value as its change ('' is "Not set"). */
function bulkChangeOf(body: BulkBody): BulkChange | undefined {
  return BULK_CHANGES[body.property](body);
}

// Each bulk property's reader of its posted value.
const BULK_CHANGES: Record<
  BulkProperty,
  (body: BulkBody) => BulkChange | undefined
> = {
  warmth: (body) => ({
    property: 'warmth',
    value: pick(WARMTHS, orEmpty(body.warmth)),
  }),
  formality: (body) => ({
    property: 'formality',
    value: pick(FORMALITIES, orEmpty(body.formality)),
  }),
  // Added, never cleared: no value is no change.
  materials: (body) =>
    body.material ? { property: 'materials', value: body.material } : undefined,
  pattern: (body) => ({
    property: 'pattern',
    value: pick(PATTERNS, orEmpty(body.pattern)),
  }),
  fit: (body) => ({ property: 'fit', value: pick(FITS, orEmpty(body.fit)) }),
  sleeve: (body) => ({
    property: 'sleeve',
    value: pick(SLEEVES, orEmpty(body.sleeve)),
  }),
  length: (body) => ({
    property: 'length',
    value: pick(LENGTHS, orEmpty(body.length)),
  }),
  waterResistant: (body) => ({
    property: 'waterResistant',
    value: body.waterResistant === 'true',
  }),
  // Good is the reset: no value is no change.
  condition: (body) =>
    body.condition
      ? { property: 'condition', value: body.condition }
      : undefined,
};

/** GET /wardrobe/tag: the wardrobe, and where Next left off. */
export const TagQuery = Type.Object({
  ...OwnerQuery.properties,
  before: Type.Optional(RowId),
});

/**
 * POST /wardrobe/:id/tag: the tagging card's chips, posted whole on every
 * tap. A field the card never showed or the user never tapped is absent and
 * leaves the stored value; a type outside the garment's category is a 400
 * (the card only offers its own).
 */
export const TagBody = Type.Object({
  type: Type.Optional(Type.String({ maxLength: 40 })),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
});
export type TagBody = Static<typeof TagBody>;

/** What the tagging card reads and writes of a garment. */
type Taggable = Pick<
  GarmentPropertyFields,
  | 'type'
  | 'warmth'
  | 'formality'
  | 'sleeve'
  | 'length'
  | 'waterResistant'
  | 'fabricWeight'
> & { category: string };

/**
 * The properties to store after a tap on the tagging card, or undefined for
 * a type the category does not have. The tapped values replace the stored
 * ones; a type brings its presets into properties still unset or still at
 * the stored type's presets (applyPresets from the stored type): the first
 * tag never overwrites what the garment form set, the heavy tee's warmth
 * included, and changing one's mind about the type moves what the first
 * type filled. Properties outside the garment's role stay as stored (null).
 */
export function readTags(
  body: TagBody,
  stored: Taggable,
): Partial<GarmentPropertyFields> | undefined {
  const { category } = stored;
  const type = body.type ? findType(category, body.type)?.value : stored.type;
  if (type === undefined) return undefined;
  // A value for a property the role lacks (never on the card) is ignored;
  // presets only fill properties the role has (the type table's rule).
  const tapped = (property: 'warmth' | 'formality', posted?: string) =>
    posted !== undefined && propertyApplies(property, category)
      ? posted
      : undefined;
  const warmth = tapped('warmth', body.warmth);
  const formality = tapped('formality', body.formality);
  return {
    type,
    ...applyPresets(
      {
        warmth: warmth === undefined ? stored.warmth : pick(WARMTHS, warmth),
        formality:
          formality === undefined
            ? stored.formality
            : pick(FORMALITIES, formality),
        sleeve: stored.sleeve,
        length: stored.length,
        waterResistant: stored.waterResistant,
      },
      // From the stored type: a tap on another type moves the values
      // still at the first type's presets (the card saves every tap, so
      // they are stored); the first tag has no source and fills only what
      // is unset. The same rule as the form's hidden presetType.
      stored.type === null
        ? null
        : { category, type: stored.type, fabricWeight: stored.fabricWeight },
      { category, type, fabricWeight: stored.fabricWeight },
    ),
  };
}
