/**
 * How old a page on screen is, in words: "3 minutes ago", "yesterday".
 * Pure, for public/js/freshness.js (and its unit spec,
 * src/web/layout/age-label.spec.ts).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Younger than this, a copy is as good as live: no indicator. */
export const STALE_AFTER_MS = MINUTE;

/**
 * The largest whole unit of an age, or null under a minute (and for a
 * negative age, from a clock set back).
 *
 * @param {number} ageMs
 * @returns {{ value: number, unit: 'day' | 'hour' | 'minute' } | null}
 */
export function ageParts(ageMs) {
  if (!(ageMs >= STALE_AFTER_MS)) return null;
  if (ageMs >= DAY) return { value: Math.floor(ageMs / DAY), unit: 'day' };
  if (ageMs >= HOUR) return { value: Math.floor(ageMs / HOUR), unit: 'hour' };
  return { value: Math.floor(ageMs / MINUTE), unit: 'minute' };
}

/**
 * @param {number} ageMs
 * @param {string} locale the document's language
 * @returns {string | null} null while the age is under a minute
 */
export function ageLabel(ageMs, locale) {
  const parts = ageParts(ageMs);
  if (!parts) return null;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    -parts.value,
    parts.unit,
  );
}
