import { type Static, Type } from '@sinclair/typebox';
import type { FieldErrors } from '../auth/validation';
import { type IsoDate, parseIsoDate } from '../calendar/calendar-date';
import { t } from '../i18n';
import { RowId } from '../schemas';
import {
  GARMENT_COLORS,
  isGarmentColor,
  normalizeCategory,
  normalizeSize,
} from './garment';

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

// Room for a hostile value to reach readGarmentForm and be named in its
// message; every real colour is a few letters.
const ColorValue = Type.String({ maxLength: 40 });

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
}

export type GarmentField = 'category' | 'color' | 'dateAquired';

/** A garment's fields as stored: trimmed, null when blank. */
export interface GarmentFields {
  name: string | null;
  category: string;
  brand: string | null;
  /** Comma-joined GARMENT_COLORS, in the form's order; null for none. */
  color: string | null;
  size: string | null;
  notes: string | null;
  washingDetails: string | null;
  acquiredOn: IsoDate | null;
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
  };
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

/** The posted form as the garment to store, or what to show the person. */
export function readGarmentForm(body: GarmentBody): GarmentForm {
  const category = normalizeCategory(body.category);
  const colors = readColors(body.color);
  const acquiredOn = readDay(body.dateAquired);
  if (!category || colors.errors.length > 0 || acquiredOn === undefined) {
    const errors: FieldErrors<GarmentField> = {};
    if (!category) errors.category = [t('validation.CATEGORY_REQUIRED')];
    if (colors.errors.length > 0) errors.color = colors.errors;
    if (acquiredOn === undefined) {
      errors.dateAquired = [t('validation.INVALID_DATE')];
    }
    return { ok: false, values: formValues(body), errors };
  }
  return {
    ok: true,
    fields: {
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
  archived: Type.Optional(Type.String({ maxLength: 10 })),
};

export const GridQuery = Type.Object({
  ...OwnerQuery.properties,
  ...GridFilters,
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
});
