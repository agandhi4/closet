import { compareOccasions, type Occasion } from '../../wardrobe/occasions';
import { FORECAST_DAYS } from '../../weather/forecast';
import type { PlannedBy, TemplateSlot } from '../../wardrobe/week';
import { emptySlots } from '../../wardrobe/week-planner';
import type { CollageGarment } from '../outfits/collage';
import type { DetachedLook, SelfieRef } from '../selfies/queries';
import {
  addDays,
  addMonths,
  dateParts,
  dayOfWeek,
  daysInMonth,
  firstOfMonth,
  formatIsoDate,
  formatYearMonth,
  type IsoDate,
  startOfWeek,
  type YearMonth,
} from './calendar-date';

/**
 * The calendar's page models, built from plain dates only (calendar-date.ts):
 * the Sunday-to-Saturday week as an agenda, and a month as a grid of days
 * (the history). Pure, so the date rules are unit-tested without a database
 * or a clock (calendar-view.spec.ts); the routes supply "today" in
 * APP_TIMEZONE.
 */

/** A scheduled outfit as findEntries() reads it. */
export interface CalendarEntry {
  id: number;
  day: IsoDate;
  occasion: Occasion;
  worn: boolean;
  /** The outfit selfie taken for it (#19), if any. */
  selfie: SelfieRef | null;
  /** 'auto': the week planner's pick, still its to swap (#16). */
  plannedBy: PlannedBy;
  outfit: {
    id: number;
    name: string | null;
    /** In slot order, for its OutfitCollage. */
    garments: CollageGarment[];
  };
}

export interface CalendarDayView {
  date: IsoDate;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  isToday: boolean;
  /** After today: nothing on it can be marked worn yet (setEntryWorn). */
  isFuture: boolean;
  /** In occasion order (src/wardrobe/occasions.ts), then as read. */
  entries: CalendarEntry[];
  /**
   * The week template's occasions (#16) the day has no outfit for yet, in
   * occasion order (emptySlots, "Plan my week"'s rule): today and later
   * only, each a row to plan.
   */
  openSlots: Occasion[];
  /** Selfies kept after their outfit was deleted (#19), as taken. */
  looks: DetachedLook[];
}

export interface CalendarView {
  days: CalendarDayView[];
  /** The Sundays of the weeks before and after, for ‹ and ›. */
  prevWeek: IsoDate;
  nextWeek: IsoDate;
}

/** The week to show: the one containing `anchor`, Sunday first. */
export function weekOf(anchor: IsoDate): { start: IsoDate; end: IsoDate } {
  const start = startOfWeek(anchor);
  return { start, end: addDays(start, 6) };
}

/** A day's entries in occasion order; the stable sort keeps them as read after that. */
function entriesOn(entries: CalendarEntry[], date: IsoDate): CalendarEntry[] {
  return entries
    .filter((entry) => entry.day === date)
    .sort((a, b) => compareOccasions(a.occasion, b.occasion));
}

export function buildCalendarView(input: {
  /** The Sunday that starts the week (weekOf().start). */
  weekStart: IsoDate;
  today: IsoDate;
  /** Entries in the week, by day then id; others are ignored. */
  entries: CalendarEntry[];
  /** Detached looks in the week (detachedLooksSql, read by weekContext); none when absent. */
  looks?: DetachedLook[];
  /** The owner's week template (#16); no open slots when absent. */
  template?: readonly TemplateSlot[];
}): CalendarView {
  const { weekStart, today, entries, looks = [], template = [] } = input;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const open = emptySlots({
    today,
    // The start of the day: /calendar is a stale-while-revalidate tab root
    // and must render the same all day, so none of today's slots has ended.
    hour: 0,
    // ISO dates compare correctly as strings.
    days: dates.filter((date) => date >= today),
    template,
    entries,
  });
  return {
    days: dates.map(
      (date): CalendarDayView => ({
        date,
        weekday: dayOfWeek(date),
        isToday: date === today,
        isFuture: date > today,
        entries: entriesOn(entries, date),
        openSlots: open
          .filter((slot) => slot.day === date)
          .map((slot) => slot.occasion),
        looks: looks.filter((look) => look.day === date),
      }),
    ),
    prevWeek: addDays(weekStart, -7),
    nextWeek: addDays(weekStart, 7),
  };
}

export interface MonthDayView {
  date: IsoDate;
  dayNum: number;
  isToday: boolean;
  /** In occasion order: the cell shows the first. */
  entries: CalendarEntry[];
  /** Within `MonthView.forecast`: the cell keeps room for its weather chip. */
  inForecast: boolean;
}

export interface MonthView {
  month: YearMonth;
  /** Sunday-to-Saturday rows; null is a day of the month before or after. */
  weeks: (MonthDayView | null)[][];
  /**
   * The month's days the forecast can reach (today to FORECAST_DAYS on), the
   * range the grid asks the weather summary for; null for a month wholly
   * before or past it, which asks for nothing. Depends on today alone, so the
   * page stays the same all day (src/web/weather/views.tsx).
   */
  forecast: { from: IsoDate; to: IsoDate } | null;
  /** 'YYYY-MM' of the neighbouring months, for ‹ and ›. */
  prev: string;
  next: string;
}

/** A month's first and last day: the range its entries are read for. */
export function monthRange(month: YearMonth): {
  first: IsoDate;
  last: IsoDate;
} {
  return {
    first: firstOfMonth(month),
    last: formatIsoDate(month.year, month.month, daysInMonth(month)),
  };
}

export function buildMonthView(input: {
  month: YearMonth;
  today: IsoDate;
  /** Entries in the month, by day then id; others are ignored. */
  entries: CalendarEntry[];
}): MonthView {
  const { month, today, entries } = input;
  const first = firstOfMonth(month);
  const forecast = forecastRange(month, today);
  const cells: (MonthDayView | null)[] = [
    ...Array.from({ length: dayOfWeek(first) }, () => null),
    ...Array.from({ length: daysInMonth(month) }, (_, i): MonthDayView => {
      const date = addDays(first, i);
      return {
        date,
        dayNum: dateParts(date).day,
        isToday: date === today,
        entries: entriesOn(entries, date),
        inForecast:
          forecast !== null && date >= forecast.from && date <= forecast.to,
      };
    }),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return {
    month,
    forecast,
    weeks: Array.from({ length: cells.length / 7 }, (_, row) =>
      cells.slice(row * 7, row * 7 + 7),
    ),
    prev: formatYearMonth(addMonths(month, -1)),
    next: formatYearMonth(addMonths(month, 1)),
  };
}

// ISO dates order as strings, so the overlap is two string comparisons.
function forecastRange(
  month: YearMonth,
  today: IsoDate,
): { from: IsoDate; to: IsoDate } | null {
  const { first, last } = monthRange(month);
  const forecastLast = addDays(today, FORECAST_DAYS - 1);
  const from = first > today ? first : today;
  const to = last < forecastLast ? last : forecastLast;
  return from <= to ? { from, to } : null;
}
