/**
 * Calendar days as plain dates: a day is its 'YYYY-MM-DD' string from the
 * database column (outfit_calendar.day, Postgres `date`) through the URL and
 * back, and all arithmetic happens on day numbers, never on a JS Date. A Date
 * is an instant, so stepping one by 24 hours or with local-time setters
 * mislabels days as soon as the process's zone observes DST (the
 * spring-forward week once read 8, 8, 9, ...).
 *
 * The one place an instant becomes a day is todayIn(): "today" is the
 * household's date in APP_TIMEZONE, not the server's and not UTC.
 */

/** 'YYYY-MM-DD'. Only parseIsoDate() and the database produce one. */
export type IsoDate = string;

export interface YearMonth {
  year: number;
  /** 1-12 */
  month: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

/**
 * A real calendar date in 'YYYY-MM-DD' form, else undefined ('2026-02-30',
 * '2026-9-1' and ISO timestamps are not dates). The same rule as the
 * `format: 'date'` the routes' schemas validate with (ajv-formats, full
 * mode), for the query parameters that fall back instead of failing.
 */
export function parseIsoDate(value: string | undefined): IsoDate | undefined {
  const match = value === undefined ? null : ISO_DATE.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth({ year, month })) return undefined;
  return value;
}

/** 'YYYY-MM' (the mini month's ?calMonth=), else undefined. */
export function parseYearMonth(
  value: string | undefined,
): YearMonth | undefined {
  const match = value === undefined ? null : ISO_MONTH.exec(value);
  if (!match) return undefined;
  const [year, month] = match.slice(1).map(Number);
  return month >= 1 && month <= 12 ? { year, month } : undefined;
}

/** True when Intl knows the IANA zone name (APP_TIMEZONE is checked at boot). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date in `timeZone` at the instant `now`. */
export function todayIn(timeZone: string, now: Date): IsoDate {
  // en-CA formats as YYYY-MM-DD; formatToParts avoids relying on that.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)!.value);
  return formatIsoDate(part('year'), part('month'), part('day'));
}

export function formatIsoDate(
  year: number,
  month: number,
  day: number,
): IsoDate {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

export function formatYearMonth({ year, month }: YearMonth): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}`;
}

export function dateParts(date: IsoDate): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

export function yearMonthOf(date: IsoDate): YearMonth {
  const { year, month } = dateParts(date);
  return { year, month };
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  // Day 0 (1970-01-01) was a Thursday.
  return (((toDayNumber(date) + 4) % 7) + 7) % 7;
}

/** The Sunday on or before `date`: weeks run Sunday to Saturday. */
export function startOfWeek(date: IsoDate): IsoDate {
  return addDays(date, -dayOfWeek(date));
}

export function addMonths(
  { year, month }: YearMonth,
  months: number,
): YearMonth {
  const index = year * 12 + (month - 1) + months;
  return {
    year: Math.floor(index / 12),
    month: (((index % 12) + 12) % 12) + 1,
  };
}

export function firstOfMonth({ year, month }: YearMonth): IsoDate {
  return formatIsoDate(year, month, 1);
}

export function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

export function daysInMonth({ year, month }: YearMonth): number {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month === 2 && isLeapYear(year) ? 29 : days;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// Days since 1970-01-01 in the proleptic Gregorian calendar and back, by
// Howard Hinnant's days_from_civil / civil_from_days
// (https://howardhinnant.github.io/date_algorithms.html): integer math only.
function toDayNumber(date: IsoDate): number {
  const { year, month, day } = dateParts(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function fromDayNumber(dayNumber: number): IsoDate {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return formatIsoDate(year, month, day);
}
