/**
 * Brands as people type them (#24; plan section 16). A garment's brand is
 * free text, so "UNIQLO", "Uniqlo " and "uniqlo" must be one brand wherever
 * brands are compared: insights' brand breakdown and the per-brand size
 * notes (src/web/sizes). Pure.
 */

/**
 * The brand as it is shown and stored: trimmed, runs of spaces made one, in
 * Unicode's composed form (NFC), so an "é" typed as e + accent is the "é".
 */
export function brandSpelling(brand: string): string {
  return brand.trim().replace(/\s+/g, ' ').normalize('NFC');
}

/**
 * What two spellings of one brand share; '' for a blank brand. The one
 * normaliser: the size notes store it (`brand_size.brand_key`, unique per
 * user) and look notes up by it, so never compare brands with SQL's
 * lower(), whose rules (the collation's) differ for non-ASCII.
 *
 * Case folded close to Unicode's full folding, which toLowerCase alone is
 * not: "ß" only becomes "ss" through upper case, and "ẞ" is its own upper
 * case, so lower, upper, lower makes "ß", "ẞ" and "SS" one. NFC comes first
 * so "İ" typed as I + dot folds like the one character.
 */
export function brandKey(brand: string): string {
  return brandSpelling(brand).toLowerCase().toUpperCase().toLowerCase();
}
