/**
 * The style profile's value sets (#34, slice 34a; plan section 15): what a
 * person dresses for and toward, one profile per user. Pure: no database,
 * web or strings (labels are the catalog's `style.<set>.<value>`); the check
 * constraints on style_profile list these (src/db/schema.ts), so adding a
 * value is a migration, like a garment property's.
 *
 * The palette is GARMENT_COLORS (src/wardrobe/properties.ts). The week's
 * rhythm ("work 3 a week") is not stored with the profile: it is derived
 * from the week template (src/wardrobe/week.ts weeklyRhythm, #16), the one
 * model of the week's shape. The home city is not here either: the weather
 * (#14) keeps it (user_weather), and the style page shows it read-only from
 * there rather than hold a second copy.
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
