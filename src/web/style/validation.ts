import { type Static, Type } from '@sinclair/typebox';
import {
  GARMENT_COLORS,
  type GarmentColor,
  storedSet,
} from '../../wardrobe/properties';
import {
  type BudgetBand,
  BUDGET_BANDS,
  type Style,
  STYLES,
} from '../../wardrobe/style';
import { choice, pick } from '../schemas';

export const STYLE_NOTES_MAX = 2000;

/** The style profile page's one-shot flag (the toast after a save). */
export const StyleProfileQuery = Type.Object({
  saved: Type.Optional(Type.String({ maxLength: 5 })),
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
