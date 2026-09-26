import { describe, expect, it } from 'vitest';
import { parseIsoDate, todayIn, type IsoDate } from './calendar-date';
import {
  buildCalendarView,
  type CalendarEntry,
  type CalendarView,
  weekOf,
} from './calendar-view';

/**
 * The calendar page's date logic, as GET /calendar runs it (src/web/calendar/
 * routes.tsx): the week around ?week= (or today), the seven days and where
 * entries land, the mini-month grid, month and year boundaries, leap day,
 * both 2026 DST transitions, and "today" in the household's zone. Runs in
 * America/New_York (the `unit-new-york` project) because a DST zone is where
 * a hidden dependency on the process's zone would show.
 */

const ZONE = 'America/New_York';
/** Friday 25 Sep 2026 in New York. */
const TODAY = '2026-09-25';

function entryOn(day: IsoDate, id: number): CalendarEntry {
  return {
    id,
    day,
    worn: false,
    outfit: { id, name: `Outfit ${id}`, photoUrls: [] },
  };
}

/** What the route renders for ?week= and ?calMonth=, given today. */
function view(
  week?: string,
  options: {
    calMonth?: { year: number; month: number };
    entries?: CalendarEntry[];
    today?: IsoDate;
  } = {},
): CalendarView {
  const today = options.today ?? TODAY;
  return buildCalendarView({
    weekStart: weekOf(parseIsoDate(week) ?? today).start,
    calMonth: options.calMonth,
    today,
    entries: options.entries ?? [],
  });
}

const dates = (vm: CalendarView) => vm.days.map((d) => d.date);
const dayNums = (vm: CalendarView) => vm.days.map((d) => d.dayNum);
const entryIdsByDay = (vm: CalendarView) =>
  vm.days.map((d) => d.entries.map((e) => e.id));
const gridRows = (vm: CalendarView) => vm.miniMonth.weeks.map((w) => w.start);
const cellsWith = (vm: CalendarView, cssClass: string) =>
  vm.miniMonth.weeks.flatMap((w) =>
    w.days.filter((d) => d.cellClass === cssClass).map((d) => d.dayNum),
  );

describe('calendar view (America/New_York)', () => {
  it('runs in New York time (the project env took effect)', () => {
    expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(300);
    expect(new Date('2026-07-15T12:00:00Z').getTimezoneOffset()).toBe(240);
  });

  describe('week construction', () => {
    it('a mid-week ?week= shows the Sunday-to-Saturday week around it', () => {
      const vm = view('2026-09-23');
      expect(dates(vm)).toEqual([
        '2026-09-20',
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
        '2026-09-24',
        '2026-09-25',
        '2026-09-26',
      ]);
      expect(vm.days.map((d) => d.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('queries exactly the seven days of the week', () => {
      expect(weekOf('2026-09-23')).toEqual({
        start: '2026-09-20',
        end: '2026-09-26',
      });
    });

    it('a Sunday starts its own week and a Saturday ends it', () => {
      expect(weekOf('2026-09-20').start).toBe('2026-09-20');
      expect(weekOf('2026-09-26').start).toBe('2026-09-20');
      expect(weekOf('2026-09-27').start).toBe('2026-09-27');
    });

    it('puts each entry on the day of its date and drops dates outside the week', () => {
      const entries = [
        entryOn('2026-09-20', 1),
        entryOn('2026-09-23', 2),
        entryOn('2026-09-23', 3),
        entryOn('2026-09-26', 4),
        entryOn('2026-09-27', 5),
        entryOn('2026-09-19', 6),
      ];
      expect(entryIdsByDay(view('2026-09-23', { entries }))).toEqual([
        [1],
        [],
        [],
        [2, 3],
        [],
        [],
        [4],
      ]);
    });

    it('gives entries on the same day different chip hues', () => {
      const entries = [1, 2, 3, 4].map((id) => entryOn('2026-09-23', id));
      const wednesday = view('2026-09-23', { entries }).days[3];
      expect(wednesday.entries.map((e) => e.chipHue)).toEqual([
        220, 240, 260, 220,
      ]);
    });
  });

  describe('mini-month grid', () => {
    it('September 2026 (starts on a Tuesday): five rows from Aug 30, the week highlighted', () => {
      const vm = view('2026-09-09');
      expect(vm.miniMonth.month).toEqual({ year: 2026, month: 9 });
      expect(gridRows(vm)).toEqual([
        '2026-08-30',
        '2026-09-06',
        '2026-09-13',
        '2026-09-20',
        '2026-09-27',
      ]);
      expect(vm.miniMonth.weeks[0].days.map((d) => d.dayNum)).toEqual([
        30, 31, 1, 2, 3, 4, 5,
      ]);
      expect(vm.miniMonth.weeks[4].days.map((d) => d.dayNum)).toEqual([
        27, 28, 29, 30, 1, 2, 3,
      ]);
      expect(cellsWith(vm, 'cal-in-week')).toEqual([6, 7, 8, 9, 10, 11, 12]);
      expect(cellsWith(vm, 'cal-out-month')).toEqual([30, 31, 1, 2, 3]);
      expect(vm.miniMonth.prev.calMonth).toBe('2026-08');
      expect(vm.miniMonth.next.calMonth).toBe('2026-10');
    });

    it('February 2026 (Sunday to Saturday, 28 days) is exactly four rows', () => {
      const vm = view('2026-02-11');
      expect(gridRows(vm)).toEqual([
        '2026-02-01',
        '2026-02-08',
        '2026-02-15',
        '2026-02-22',
      ]);
      expect(cellsWith(vm, 'cal-out-month')).toEqual([]);
    });

    it('August 2026 (Saturday the 1st, 31 days) needs six rows', () => {
      const vm = view('2026-08-12');
      expect(gridRows(vm)).toEqual([
        '2026-07-26',
        '2026-08-02',
        '2026-08-09',
        '2026-08-16',
        '2026-08-23',
        '2026-08-30',
      ]);
      expect(vm.miniMonth.weeks[5].days.map((d) => d.dayNum)).toEqual([
        30, 31, 1, 2, 3, 4, 5,
      ]);
    });

    it('month navigation jumps to the current week when it reaches the current month', () => {
      // Today is 25 Sep 2026; October's "previous month" link is September.
      const vm = view('2026-10-14');
      expect(vm.miniMonth.prev).toEqual({
        calMonth: '2026-09',
        week: '2026-09-20',
      });
      // November 1 2026 is a Sunday: its first row starts on the 1st.
      expect(vm.miniMonth.next).toEqual({
        calMonth: '2026-11',
        week: '2026-11-01',
      });
    });
  });

  describe('year boundary (December to January)', () => {
    it('the week of Dec 27 2026 runs into January', () => {
      const entries = [entryOn('2026-12-31', 1), entryOn('2027-01-01', 2)];
      const vm = view('2026-12-30', { entries });
      expect(dates(vm)[0]).toBe('2026-12-27');
      expect(dayNums(vm)).toEqual([27, 28, 29, 30, 31, 1, 2]);
      expect(dates(vm)[5]).toBe('2027-01-01');
      expect(entryIdsByDay(vm)).toEqual([[], [], [], [], [1], [2], []]);
    });

    it('a January date finds the week that started in December', () => {
      expect(weekOf('2027-01-02').start).toBe('2026-12-27');
    });

    it('the mini month steps from December 2026 to January 2027 and back', () => {
      const december = view('2026-12-30');
      expect(december.miniMonth.month).toEqual({ year: 2026, month: 12 });
      expect(december.miniMonth.prev.calMonth).toBe('2026-11');
      expect(december.miniMonth.next.calMonth).toBe('2027-01');
      // Jan 1 2027 is a Friday: its first row starts on Dec 27.
      expect(december.miniMonth.next.week).toBe('2026-12-27');

      const january = view('2026-12-30', {
        calMonth: { year: 2027, month: 1 },
      });
      expect(january.miniMonth.month).toEqual({ year: 2027, month: 1 });
      expect(january.miniMonth.prev.calMonth).toBe('2026-12');
      expect(january.miniMonth.next.calMonth).toBe('2027-02');
      expect(gridRows(january)[0]).toBe('2026-12-27');
      // The week shown (Dec 27 - Jan 2) is highlighted across both months.
      expect(cellsWith(january, 'cal-in-week')).toEqual([
        27, 28, 29, 30, 31, 1, 2,
      ]);
    });
  });

  describe('leap day', () => {
    it('Feb 29 2028 is a day of its week and holds its entries', () => {
      const entries = [entryOn('2028-02-29', 1), entryOn('2028-03-01', 2)];
      const vm = view('2028-02-29', { entries });
      expect(dates(vm)[0]).toBe('2028-02-27');
      expect(dates(vm).slice(1, 4)).toEqual([
        '2028-02-28',
        '2028-02-29',
        '2028-03-01',
      ]);
      expect(entryIdsByDay(vm)).toEqual([[], [], [1], [2], [], [], []]);
      expect(vm.miniMonth.weeks.at(-1)!.days.map((d) => d.dayNum)).toEqual([
        27, 28, 29, 1, 2, 3, 4,
      ]);
    });

    it('a non-leap February goes straight from the 28th to March 1', () => {
      const vm = view('2027-03-02');
      expect(dates(vm)[0]).toBe('2027-02-28');
      expect(dayNums(vm)).toEqual([28, 1, 2, 3, 4, 5, 6]);
    });
  });

  describe('DST transitions in New York', () => {
    // Clocks jump forward at 02:00 on Sunday 8 March 2026.
    it('entries in the spring-forward week land on their days', () => {
      const entries = [entryOn('2026-03-08', 1), entryOn('2026-03-14', 2)];
      expect(entryIdsByDay(view('2026-03-10', { entries }))).toEqual([
        [1],
        [],
        [],
        [],
        [],
        [],
        [2],
      ]);
    });

    it('the spring-forward week shows Mar 8 to Mar 14', () => {
      const vm = view('2026-03-10');
      expect(dayNums(vm)).toEqual([8, 9, 10, 11, 12, 13, 14]);
      expect(dates(vm)[6]).toBe('2026-03-14');
    });

    // Clocks fall back at 02:00 on Sunday 1 November 2026.
    it('the fall-back week shows Nov 1 to Nov 7 with its entries', () => {
      const entries = [
        entryOn('2026-11-01', 1),
        entryOn('2026-11-07', 2),
        entryOn('2026-11-08', 3),
      ];
      const vm = view('2026-11-04', { entries });
      expect(dates(vm)[0]).toBe('2026-11-01');
      expect(dayNums(vm)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(entryIdsByDay(vm)).toEqual([[1], [], [], [], [], [], [2]]);
    });
  });

  describe('today', () => {
    it('highlights today in the week and in the mini month', () => {
      const vm = view('2026-09-23');
      expect(vm.days.map((d) => d.isToday)).toEqual([
        false,
        false,
        false,
        false,
        false,
        true,
        false,
      ]);
      expect(cellsWith(vm, 'cal-today')).toEqual([25]);
    });

    it('without ?week= (or with a malformed one) shows the current week', () => {
      expect(dates(view())[0]).toBe('2026-09-20');
      expect(dates(view('not-a-date'))[0]).toBe('2026-09-20');
    });

    it('at 21:30 on Friday evening, today is still Friday', () => {
      const today = todayIn(ZONE, new Date('2026-09-25T21:30:00-04:00'));
      expect(today).toBe('2026-09-25');
      const vm = view('2026-09-23', { today });
      expect(vm.days[5].isToday).toBe(true);
    });

    it('on Saturday evening the default week is still this week', () => {
      const today = todayIn(ZONE, new Date('2026-09-26T21:00:00-04:00'));
      expect(dates(view(undefined, { today }))[0]).toBe('2026-09-20');
    });
  });
});
