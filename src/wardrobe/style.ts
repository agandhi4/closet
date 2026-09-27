/**
 * The style profile's value sets (#34, slice 34a; plan section 15): what a
 * person dresses for and toward, one profile per user. Pure: no database,
 * web or strings (labels are the catalog's `style.<set>.<value>`); the check
 * constraints on style_profile and style_rhythm list these (src/db/schema.ts),
 * so adding a value is a migration, like a garment property's.
 *
 * The palette is GARMENT_COLORS (src/wardrobe/properties.ts) and the week's
 * rhythm is counted per OCCASION (src/wardrobe/occasions.ts): the words the
 * calendar (#13) and the future week template (#16) already use, so "work 3
 * a week" here and a work entry on the calendar are the same thing. The home
 * city is not here: the weather (#14) keeps it (user_weather), and the style
 * page shows it read-only from there rather than hold a second copy.
 */

/** Ways of dressing, as a person would name their own. A profile holds a few. */
export const STYLES = [
  'elevated-basics',
  'smart-casual',
  'minimal',
  'classic',
  'workwear',
  'outdoor-technical',
  'streetwear',
  'athleisure',
] as const;
export type Style = (typeof STYLES)[number];

/**
 * What a typical piece costs, in the household's currency (US dollars):
 * budget under $50, mid $50 to $150, premium $150 to $400, luxury above.
 * The bounds are the labels' words, not rules anything enforces.
 */
export const BUDGET_BANDS = ['budget', 'mid', 'premium', 'luxury'] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];

/** How often an occasion comes round: so many times a week, or a month. */
export const RHYTHM_PERIODS = ['week', 'month'] as const;
export type RhythmPeriod = (typeof RHYTHM_PERIODS)[number];

/** Times per period: a month has at most 31 days (a week's count stays under it). */
export const RHYTHM_TIMES_MAX = 31;
