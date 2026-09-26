import {
  addDays,
  addMonths,
  dateParts,
  dayOfWeek,
  firstOfMonth,
  formatYearMonth,
  type IsoDate,
  sameMonth,
  startOfWeek,
  yearMonthOf,
  type YearMonth,
} from './calendar-date';

/**
 * The calendar page's model, built from plain dates only (calendar-date.ts):
 * the Sunday-to-Saturday week with its entries, and the mini month beside it.
 * Pure, so the date rules are unit-tested without a database or a clock
 * (calendar-view.spec.ts); the route supplies "today" in APP_TIMEZONE.
 */

/** A scheduled outfit as findWeekEntries() reads it. */
export interface CalendarEntry {
  id: number;
  day: IsoDate;
  worn: boolean;
  outfit: {
    id: number;
    name: string | null;
    /** Thumb URLs of the outfit's garments that have a photo. */
    photoUrls: string[];
  };
}

export interface CalendarEntryView extends CalendarEntry {
  /** Hue of the entry's chip, cycling within a day so neighbours differ. */
  chipHue: number;
}

export interface CalendarDayView {
  date: IsoDate;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  dayNum: number;
  isToday: boolean;
  entries: CalendarEntryView[];
}

export type MiniMonthCellClass =
  | 'cal-today'
  | 'cal-in-week'
  | 'cal-out-month'
  | '';

export interface MiniMonthView {
  month: YearMonth;
  /** Rows of the grid, each linking to the week it shows. */
  weeks: {
    start: IsoDate;
    days: { dayNum: number; cellClass: MiniMonthCellClass }[];
  }[];
  prev: MonthLink;
  next: MonthLink;
}

/** A neighbouring month: its `?calMonth=` and the week the link opens. */
export interface MonthLink {
  calMonth: string;
  week: IsoDate;
}

export interface CalendarView {
  days: CalendarDayView[];
  miniMonth: MiniMonthView;
}

const CHIP_HUES = [220, 240, 260];
/** Enough rows for any month: 31 days starting on a Saturday span six weeks. */
const MAX_GRID_ROWS = 6;

/** The week to show: the one containing `anchor`, Sunday first. */
export function weekOf(anchor: IsoDate): { start: IsoDate; end: IsoDate } {
  const start = startOfWeek(anchor);
  return { start, end: addDays(start, 6) };
}

export function buildCalendarView(input: {
  /** The Sunday that starts the week (weekOf().start). */
  weekStart: IsoDate;
  /** The mini month to show; the week's month when absent. */
  calMonth?: YearMonth;
  today: IsoDate;
  /** Entries in the week, in display order; others are ignored. */
  entries: CalendarEntry[];
}): CalendarView {
  const { weekStart, today, entries } = input;
  const days = Array.from({ length: 7 }, (_, i): CalendarDayView => {
    const date = addDays(weekStart, i);
    return {
      date,
      weekday: dayOfWeek(date),
      dayNum: dateParts(date).day,
      isToday: date === today,
      entries: entries
        .filter((entry) => entry.day === date)
        .map((entry, index) => ({
          ...entry,
          chipHue: CHIP_HUES[index % CHIP_HUES.length],
        })),
    };
  });
  const month = input.calMonth ?? yearMonthOf(weekStart);
  return {
    days,
    miniMonth: {
      month,
      weeks: monthGrid(month, today, weekStart, addDays(weekStart, 6)),
      prev: monthLink(addMonths(month, -1), today),
      next: monthLink(addMonths(month, 1), today),
    },
  };
}

// A neighbouring month opens on the current week when it is the current
// month, else on the week of its 1st.
function monthLink(month: YearMonth, today: IsoDate): MonthLink {
  const opens = sameMonth(month, yearMonthOf(today))
    ? today
    : firstOfMonth(month);
  return { calMonth: formatYearMonth(month), week: startOfWeek(opens) };
}

function monthGrid(
  month: YearMonth,
  today: IsoDate,
  weekStart: IsoDate,
  weekEnd: IsoDate,
): MiniMonthView['weeks'] {
  const cellClass = (date: IsoDate): MiniMonthCellClass => {
    if (date === today) return 'cal-today';
    // ISO dates compare correctly as strings.
    if (date >= weekStart && date <= weekEnd) return 'cal-in-week';
    if (!sameMonth(yearMonthOf(date), month)) return 'cal-out-month';
    return '';
  };
  const weeks: MiniMonthView['weeks'] = [];
  let rowStart = startOfWeek(firstOfMonth(month));
  do {
    const start = rowStart;
    weeks.push({
      start,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(start, i);
        return { dayNum: dateParts(date).day, cellClass: cellClass(date) };
      }),
    });
    rowStart = addDays(rowStart, 7);
  } while (
    weeks.length < MAX_GRID_ROWS &&
    sameMonth(yearMonthOf(rowStart), month)
  );
  return weeks;
}
