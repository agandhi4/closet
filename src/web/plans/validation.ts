import { type Static, Type } from '@sinclair/typebox';
import { QUANTITY_MAX } from '../../wardrobe/availability';
import { PLAN_PRIORITIES, type PlanPriority } from '../../wardrobe/plans';
import {
  findType,
  type Formality,
  FORMALITIES,
  GARMENT_COLORS,
  type GarmentColor,
  type Material,
  MATERIALS,
  typesOf,
  type Warmth,
  WARMTHS,
} from '../../wardrobe/properties';
import {
  type BudgetBand,
  BUDGET_BANDS,
  type Style,
  STYLES,
} from '../../wardrobe/style';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { RowId } from '../schemas';
import { normalizeCategory } from '../wardrobe/garment';
import {
  CATEGORY_MAX,
  choice,
  pick,
  PRICE_INPUT_MAX,
  readPrice,
} from '../wardrobe/validation';

/**
 * The plans routes' input (#34, slice 34a): the plan form (a name and
 * notes, like a capsule's), the plan item form (a target in the garment
 * model's terms) and the style profile form. Two layers, as the garment
 * form: TypeBox caps shape, length and the fixed value sets (only the
 * form's own chips post those, so anything else is a 400), then the read
 * functions below re-render the form with a message for what a person can
 * get wrong (a blank name, a type of another category, a range the wrong
 * way round, a price). The MCP tools post through the same readers.
 */

export const PLAN_NOT_FOUND = 'Plan not found';
export const ITEM_NOT_FOUND = 'Plan item not found';

/** A plan that is not the signed-in owner's, whether it exists or not. */
export function planNotFound(): HttpError {
  return new HttpError(404, PLAN_NOT_FOUND);
}

export function itemNotFound(): HttpError {
  return new HttpError(404, ITEM_NOT_FOUND);
}

export const PLAN_NAME_MAX = 80;
export const PLAN_NOTES_MAX = 2000;
export const ITEM_NAME_MAX = 120;
export const ITEM_NOTE_MAX = 1000;
export const STYLE_NOTES_MAX = 2000;

export const PlanParams = Type.Object({ id: RowId });
export const ItemParams = Type.Object({ id: RowId, itemId: RowId });

// ---- The plan form ----------------------------------------------------------

export const PlanBody = Type.Object({
  name: Type.String({ maxLength: PLAN_NAME_MAX }),
  notes: Type.Optional(Type.String({ maxLength: PLAN_NOTES_MAX })),
});
export type PlanBody = Static<typeof PlanBody>;

/** What the plan form writes: the name trimmed and never blank, blank notes null. */
export interface PlanFields {
  name: string;
  notes: string | null;
}

export type PlanForm =
  | { ok: true; fields: PlanFields }
  | { ok: false; values: PlanBody; errors: FieldErrors<'name'> };

export function readPlanForm(body: PlanBody): PlanForm {
  const name = body.name.trim();
  if (!name) {
    return {
      ok: false,
      values: body,
      errors: { name: [t('validation.PLAN_NAME_REQUIRED')] },
    };
  }
  return { ok: true, fields: { name, notes: body.notes?.trim() || null } };
}

/** The form again after another of the owner's plans turned out to hold the name. */
export function planNameTaken(values: PlanBody): PlanForm & { ok: false } {
  return {
    ok: false,
    values,
    errors: { name: [t('validation.PLAN_NAME_TAKEN')] },
  };
}

/** Starting a plan from a wardrobe's closet: whose (the requester's own or a share). */
export const FromWardrobeBody = Type.Object({ ownerId: RowId });

/** The plan page's one-shot flags (the toasts after a write). */
export const PlanPageQuery = Type.Object({
  created: Type.Optional(Type.String({ maxLength: 5 })),
  saved: Type.Optional(Type.String({ maxLength: 5 })),
});

// ---- The plan item form -----------------------------------------------------

const PriorityValue = Type.Union(
  PLAN_PRIORITIES.map((priority) => Type.Literal(priority)),
);

/**
 * One plan item form post (new and edit). Every field but the category may
 * be left empty: an empty colour or material list, type or scale end is
 * "any". `colors` and `materials` are one value per checked chip (ajv's
 * coerceTypes 'array' makes a single one a list).
 */
export const PlanItemBody = Type.Object({
  name: Type.Optional(Type.String({ maxLength: ITEM_NAME_MAX })),
  category: Type.String({ maxLength: CATEGORY_MAX }),
  type: Type.Optional(Type.String({ maxLength: 40 })),
  colors: Type.Optional(
    Type.Array(Type.Union(GARMENT_COLORS.map((c) => Type.Literal(c))), {
      maxItems: GARMENT_COLORS.length * 2,
    }),
  ),
  materials: Type.Optional(
    Type.Array(Type.Union(MATERIALS.map((m) => Type.Literal(m))), {
      maxItems: MATERIALS.length * 2,
    }),
  ),
  warmthMin: choice(WARMTHS),
  warmthMax: choice(WARMTHS),
  formalityMin: choice(FORMALITIES),
  formalityMax: choice(FORMALITIES),
  quantity: Type.Optional(Type.String({ maxLength: 6 })),
  priority: Type.Optional(PriorityValue),
  budget: Type.Optional(Type.String({ maxLength: PRICE_INPUT_MAX })),
  note: Type.Optional(Type.String({ maxLength: ITEM_NOTE_MAX })),
});
export type PlanItemBody = Static<typeof PlanItemBody>;

/** A plan item as stored (null: any, or not set). */
export interface PlanItemFields {
  name: string | null;
  category: string;
  type: string | null;
  colors: GarmentColor[] | null;
  materials: Material[] | null;
  warmthMin: Warmth | null;
  warmthMax: Warmth | null;
  formalityMin: Formality | null;
  formalityMax: Formality | null;
  quantity: number;
  priority: PlanPriority;
  budget: string | null;
  note: string | null;
}

export type PlanItemField =
  | 'category'
  | 'type'
  | 'warmth'
  | 'formality'
  | 'quantity'
  | 'budget';

/**
 * The form's values as it shows them: the posted strings, or a stored
 * item's; every field present. Also what the MCP tools post through
 * readPlanItemForm.
 */
export type PlanItemFormValues = Required<PlanItemBody>;

export const BLANK_ITEM_VALUES: PlanItemFormValues = {
  name: '',
  category: '',
  type: '',
  colors: [],
  materials: [],
  warmthMin: '',
  warmthMax: '',
  formalityMin: '',
  formalityMax: '',
  quantity: '1',
  priority: 'medium',
  budget: '',
  note: '',
};

/** The posted form as it shows again: anything not posted at its blank value. */
export function itemFormValues(body: PlanItemBody): PlanItemFormValues {
  return { ...BLANK_ITEM_VALUES, ...body };
}

/** A scale value as its chip posts it ('' for none); also the MCP tools'. */
export function scaleText<T extends number>(value: T | null): '' | `${T}` {
  return value === null ? '' : (`${value}` as const);
}

/** A stored item as the form shows it (the edit form, and the MCP tool's merge). */
export function storedItemValues(item: PlanItemFields): PlanItemFormValues {
  return {
    name: item.name ?? '',
    category: item.category,
    type: item.type ?? '',
    colors: item.colors ?? [],
    materials: item.materials ?? [],
    warmthMin: scaleText(item.warmthMin),
    warmthMax: scaleText(item.warmthMax),
    formalityMin: scaleText(item.formalityMin),
    formalityMax: scaleText(item.formalityMax),
    quantity: String(item.quantity),
    priority: item.priority,
    budget: item.budget ?? '',
    note: item.note ?? '',
  };
}

export type PlanItemForm =
  | { ok: true; fields: PlanItemFields }
  | {
      ok: false;
      values: PlanItemFormValues;
      errors: FieldErrors<PlanItemField>;
    };

/** One reader's answer: the stored value, or the message for its field. */
type Read<T> =
  | { value: T; error?: undefined }
  | { value?: undefined; error: string };

/**
 * A scale range as stored: one end left empty is open on that side ("at
 * least 3" is 3 to the top); both empty is none; a message when the ends
 * are the wrong way round.
 */
function readRange<T extends number>(
  scale: readonly T[],
  min: string,
  max: string,
): Read<{ min: T | null; max: T | null }> {
  const low = pick(scale, min);
  const high = pick(scale, max);
  if (low === null && high === null) return { value: { min: null, max: null } };
  const from = low ?? scale[0];
  const to = high ?? scale[scale.length - 1];
  return from > to
    ? { error: t('validation.PLAN_RANGE_ORDER') }
    : { value: { min: from, max: to } };
}

/** A set in its list's order, each once; none is null (the column's rule). */
function readSet<T extends string>(
  values: readonly T[],
  posted: readonly string[],
): T[] | null {
  const chosen = values.filter((value) => posted.includes(value));
  return chosen.length > 0 ? chosen : null;
}

/** The category (trimmed, lower case, never blank), as garment.category. */
function readCategory(posted: string): Read<string> {
  const category = normalizeCategory(posted);
  return category
    ? { value: category }
    : { error: t('validation.PLAN_CATEGORY_REQUIRED') };
}

/** A type of `category` ('' is any); one of another category is a message. */
function readType(category: string, posted: string): Read<string | null> {
  const typed = posted.trim();
  if (!typed) return { value: null };
  const type = findType(category, typed);
  if (type) return { value: type.value };
  return {
    error: t(
      typesOf(category).length > 0
        ? 'validation.PLAN_TYPE_OF_CATEGORY'
        : 'validation.PLAN_TYPE_NONE',
    ),
  };
}

/** Copies wanted: a whole number from 1 to QUANTITY_MAX (blank is 1). */
function readQuantity(posted: string): Read<number> {
  const typed = posted.trim() || '1';
  const quantity = Number(typed);
  return /^\d+$/.test(typed) && quantity >= 1 && quantity <= QUANTITY_MAX
    ? { value: quantity }
    : { error: t('validation.QUANTITY_RANGE', { max: QUANTITY_MAX }) };
}

function readBudget(posted: string): Read<string | null> {
  const budget = readPrice(posted);
  return 'error' in budget ? { error: budget.error } : { value: budget.price };
}

/** The messages of the readers that refused, by field. */
function refusals(
  reads: Record<PlanItemField, Read<unknown>>,
): FieldErrors<PlanItemField> {
  const errors: FieldErrors<PlanItemField> = {};
  for (const [field, read] of Object.entries(reads)) {
    if (read.error !== undefined) errors[field as PlanItemField] = [read.error];
  }
  return errors;
}

/** Free text as stored: trimmed, null when blank. */
function textOrNull(posted: string): string | null {
  return posted.trim() || null;
}

/** A posted plan item as stored, or the form again with what is wrong. */
export function readPlanItemForm(body: PlanItemBody): PlanItemForm {
  const values = itemFormValues(body);
  const category = readCategory(values.category);
  // A type is judged against a category; without one only the category's
  // message shows.
  const type = readType(
    category.value ?? '',
    category.value ? values.type : '',
  );
  const warmth = readRange(WARMTHS, values.warmthMin, values.warmthMax);
  const formality = readRange(
    FORMALITIES,
    values.formalityMin,
    values.formalityMax,
  );
  const quantity = readQuantity(values.quantity);
  const budget = readBudget(values.budget);
  if (
    category.error !== undefined ||
    type.error !== undefined ||
    warmth.error !== undefined ||
    formality.error !== undefined ||
    quantity.error !== undefined ||
    budget.error !== undefined
  ) {
    return {
      ok: false,
      values,
      errors: refusals({ category, type, warmth, formality, quantity, budget }),
    };
  }
  return {
    ok: true,
    fields: {
      name: textOrNull(values.name),
      category: category.value,
      type: type.value,
      colors: readSet(GARMENT_COLORS, values.colors),
      materials: readSet(MATERIALS, values.materials),
      warmthMin: warmth.value.min,
      warmthMax: warmth.value.max,
      formalityMin: formality.value.min,
      formalityMax: formality.value.max,
      quantity: quantity.value,
      priority: values.priority,
      budget: budget.value,
      note: textOrNull(values.note),
    },
  };
}

// ---- The style profile form -------------------------------------------------

/** The style profile page's one-shot flag (the toast after a save). */
export const StyleProfileQuery = Type.Object({
  saved: Type.Optional(Type.String({ maxLength: 5 })),
});

/**
 * The style profile form: the chips of each set (one value per checked
 * chip), the budget band ('' for none) and notes. The week's rhythm is not
 * posted here any more: it is the week template's (#16, Profile › Your
 * week), and a page cached before that still posting `times-*`/`per-*`
 * fields has them stripped by the schema, unread.
 */
export const StyleProfileBody = Type.Object({
  styles: Type.Optional(
    Type.Array(Type.Union(STYLES.map((s) => Type.Literal(s))), {
      maxItems: STYLES.length * 2,
    }),
  ),
  budget: choice(BUDGET_BANDS),
  palette: Type.Optional(
    Type.Array(Type.Union(GARMENT_COLORS.map((c) => Type.Literal(c))), {
      maxItems: GARMENT_COLORS.length * 2,
    }),
  ),
  notes: Type.Optional(Type.String({ maxLength: STYLE_NOTES_MAX })),
});
export type StyleProfileBody = Static<typeof StyleProfileBody>;

/** A style profile as stored (a set with nothing chosen is null). */
export interface StyleProfileFields {
  styles: Style[] | null;
  budget: BudgetBand | null;
  palette: GarmentColor[] | null;
  notes: string | null;
}

export const EMPTY_STYLE_PROFILE: StyleProfileFields = {
  styles: null,
  budget: null,
  palette: null,
  notes: null,
};

/**
 * A posted style profile as stored: every value the schema let through is
 * one of its set's, so nothing is refused here; repeats and order go.
 */
export function readStyleProfileForm(
  body: StyleProfileBody,
): StyleProfileFields {
  return {
    styles: readSet(STYLES, body.styles ?? []),
    budget: pick(BUDGET_BANDS, body.budget ?? ''),
    palette: readSet(GARMENT_COLORS, body.palette ?? []),
    notes: body.notes?.trim() || null,
  };
}

/** A stored profile as the form posts it (the form's initial values). */
export function styleProfilePost(
  profile: StyleProfileFields,
): StyleProfileBody {
  return {
    styles: profile.styles ?? [],
    budget: profile.budget ?? '',
    palette: profile.palette ?? [],
    notes: profile.notes ?? '',
  };
}
