import { type Static, Type } from '@sinclair/typebox';
import {
  OUTFIT_RULE_KINDS,
  type StoredMatcher,
} from '../../wardrobe/outfit-rules';
import {
  GARMENT_COLORS,
  GARMENT_TYPES,
  GarmentCategory,
  type GarmentColor,
  type Pattern,
  PATTERNS,
  storedSet,
} from '../../wardrobe/properties';
import {
  type BudgetBand,
  BUDGET_BANDS,
  type Style,
  STYLES,
} from '../../wardrobe/style';
import { choice, pick, ROW_ID_MAX } from '../schemas';
import { STYLE_SAVED_FLAG } from './urls';

export const STYLE_NOTES_MAX = 2000;

/** The style page's one-shot flag (the toast after a write): navigation state, anything else shows none. */
export const StyleProfileQuery = Type.Object({
  [STYLE_SAVED_FLAG]: Type.Optional(Type.String({ maxLength: 20 })),
});

/**
 * The style profile form: the chips of each set (one value per checked
 * chip), the budget band ('' for none) and notes. Only the form's own chips
 * post the sets, so anything else is a 400. The week's rhythm is not posted
 * here: it is the week template's (#16, Profile › Your week), and a page
 * cached before that still posting `times-*`/`per-*` fields has them
 * stripped by the schema, unread.
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
    styles: storedSet(STYLES, body.styles ?? []),
    budget: pick(BUDGET_BANDS, body.budget ?? ''),
    palette: storedSet(GARMENT_COLORS, body.palette ?? []),
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

/**
 * An outfit rule's side (#21b) as its select posts it, one option per
 * matcher: `garment:<id>`, `category:<category>[:<type>]`, `color:<colour>`
 * or `pattern:<pattern>`. The view spells its options with these and the
 * schema accepts exactly them, so a type outside its category or a value
 * outside its set is a 400 (a hand-made request; the form offers none).
 */
export const ruleSideValue = {
  garment: (id: number) => `garment:${id}`,
  category: (category: GarmentCategory, type: string | null = null) =>
    type === null ? `category:${category}` : `category:${category}:${type}`,
  color: (color: GarmentColor) => `color:${color}`,
  pattern: (pattern: Pattern) => `pattern:${pattern}`,
};

const NO_MATCHER: StoredMatcher = {
  garmentId: null,
  category: null,
  type: null,
  color: null,
  pattern: null,
};

/** Every property option, as posted, and the side it stores. */
const PROPERTY_SIDES: ReadonlyMap<string, StoredMatcher> = new Map<
  string,
  StoredMatcher
>([
  ...Object.values(GarmentCategory).flatMap((category) =>
    [null, ...GARMENT_TYPES[category].map(({ value }) => value)].map(
      (type): [string, StoredMatcher] => [
        ruleSideValue.category(category, type),
        { ...NO_MATCHER, category, type },
      ],
    ),
  ),
  ...GARMENT_COLORS.map((color): [string, StoredMatcher] => [
    ruleSideValue.color(color),
    { ...NO_MATCHER, color },
  ]),
  ...PATTERNS.map((pattern): [string, StoredMatcher] => [
    ruleSideValue.pattern(pattern),
    { ...NO_MATCHER, pattern },
  ]),
]);

const GARMENT_SIDE = /^garment:([1-9]\d{0,9})$/;

const RuleSide = Type.Union([
  ...[...PROPERTY_SIDES.keys()].map((value) => Type.Literal(value)),
  Type.String({ pattern: GARMENT_SIDE.source }),
]);

/** The add form: the kind, then side A and side B. */
export const OutfitRuleBody = Type.Object({
  kind: Type.Union(OUTFIT_RULE_KINDS.map((kind) => Type.Literal(kind))),
  a: RuleSide,
  b: RuleSide,
});
export type OutfitRuleBody = Static<typeof OutfitRuleBody>;

/**
 * A side the schema let through, as stored; undefined for a garment id past
 * ROW_ID_MAX, which its pattern cannot bound (the route's 400, like RowId's).
 */
export function readRuleSide(value: string): StoredMatcher | undefined {
  const property = PROPERTY_SIDES.get(value);
  if (property) return property;
  const match = GARMENT_SIDE.exec(value);
  if (!match) return undefined;
  const garmentId = Number(match[1]);
  return garmentId <= ROW_ID_MAX ? { ...NO_MATCHER, garmentId } : undefined;
}
