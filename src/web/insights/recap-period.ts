import type { RecapPeriod } from '../../wardrobe/recap';
import { dateParts, formatIsoDate, type IsoDate } from '../../calendar-date';

/**
 * A recap's year and days (#26). The boundary is the household's: `today`
 * is todayIn(APP_TIMEZONE), and garment_wear.day is already that zone's
 * date, so on New Year's Eve in New York (January 1 in UTC) the current
 * year is still the old one and runs through December 31.
 */

/**
 * `?year=` is navigation state: a four-digit year up to the current one,
 * else the current year (never a 400).
 */
export function recapYear(value: string | undefined, today: IsoDate): number {
  const current = dateParts(today).year;
  if (value === undefined || !/^\d{4}$/.test(value)) return current;
  const year = Number(value);
  return year <= current ? year : current;
}

/** January 1 to December 31, or to today while the year runs. */
export function recapPeriod(year: number, today: IsoDate): RecapPeriod {
  const complete = year < dateParts(today).year;
  return {
    year,
    from: formatIsoDate(year, 1, 1),
    to: complete ? formatIsoDate(year, 12, 31) : today,
    complete,
  };
}
