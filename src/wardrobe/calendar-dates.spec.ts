import { EntityRepository } from '@mikro-orm/core';
import { I18nContext } from 'nestjs-i18n';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { OutfitCalendar } from '../dal/entity/outfit-calendar.entity';
import { Outfit } from '../dal/entity/outfit.entity';
import { CalendarService } from './calendar.service';

/**
 * The calendar's date logic, through CalendarService.buildIndexViewModel
 * with in-memory repositories and a fixed clock: week start, the week's
 * seven days and where entries land, the mini-month grid, month and year
 * boundaries, leap day, and both 2026 DST transitions. Runs in
 * America/New_York (the `unit-new-york` project in vitest.config.ts)
 * because UTC hides every local-time mistake; entry dates are UTC midnight,
 * as `new Date('YYYY-MM-DD')` in the controllers produces them.
 */

type ViewModel = Awaited<ReturnType<CalendarService['buildIndexViewModel']>>;

/** A calendar row as findWeek reads it: date plus a populated outfit. */
function entryOn(date: string, id: number): OutfitCalendar {
  const outfit = { id, name: `Outfit ${id}`, garments: { getItems: () => [] } };
  return {
    id,
    date: new Date(date),
    outfit: { unwrap: () => outfit },
  } as unknown as OutfitCalendar;
}

// Echo the key, so month and day names are asserted by key.
const i18n = {
  t: (key: string) => key.replace(/^lang\./, ''),
} as unknown as I18nContext;

/** "Friday 25 Sep 2026, 12:00 in New York", unless a test says otherwise. */
const NOON_FRIDAY = new Date('2026-09-25T12:00:00-04:00');

describe('CalendarService date logic (America/New_York)', () => {
  let entries: OutfitCalendar[];
  let calendarFind: Mock;
  let service: CalendarService;

  const view = (week?: string, calMonth?: string): Promise<ViewModel> =>
    service.buildIndexViewModel(week, calMonth, 1, i18n);

  const dates = (vm: ViewModel) => vm.days.map((d) => d.dateParam);
  const dayNums = (vm: ViewModel) => vm.days.map((d) => d.dayNum);
  const entryIdsByDay = (vm: ViewModel) =>
    vm.days.map((d) => d.entries.map((e) => e.id));
  const gridRows = (vm: ViewModel) => vm.calendarWeeks.map((w) => w.weekParam);
  const cellsWith = (vm: ViewModel, cssClass: string) =>
    vm.calendarWeeks.flatMap((w) =>
      w.days.filter((d) => d.calCellClass === cssClass).map((d) => d.dayNum),
    );

  beforeEach(() => {
    vi.useFakeTimers({ now: NOON_FRIDAY });
    entries = [];
    calendarFind = vi.fn(() => Promise.resolve(entries));
    service = new CalendarService(
      { find: calendarFind } as unknown as EntityRepository<OutfitCalendar>,
      {
        find: vi.fn().mockResolvedValue([]),
      } as unknown as EntityRepository<Outfit>,
    );
  });

  afterEach(() => vi.useRealTimers());

  it('runs in New York time (the project env took effect)', () => {
    expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(300);
    expect(new Date('2026-07-15T12:00:00Z').getTimezoneOffset()).toBe(240);
  });

  describe('week construction', () => {
    it('a mid-week ?week= shows the Sunday-to-Saturday week around it', async () => {
      const vm = await view('2026-09-23');
      expect(vm.weekParam).toBe('2026-09-20');
      expect(dates(vm)).toEqual([
        '2026-09-20',
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
        '2026-09-24',
        '2026-09-25',
        '2026-09-26',
      ]);
      expect(vm.days.map((d) => d.dayName)).toEqual([
        'CALENDAR_DAY_SUN',
        'CALENDAR_DAY_MON',
        'CALENDAR_DAY_TUE',
        'CALENDAR_DAY_WED',
        'CALENDAR_DAY_THU',
        'CALENDAR_DAY_FRI',
        'CALENDAR_DAY_SAT',
      ]);
      expect(vm.prevWeekParam).toBe('2026-09-13');
      expect(vm.nextWeekParam).toBe('2026-09-27');
      expect(vm.weekLabel).toBe('MONTH_SEP 20–26, 2026');
    });

    it('queries exactly the seven days of the week', async () => {
      await view('2026-09-23');
      const [filter] = calendarFind.mock.calls[0] as [
        { date: { $gte: Date; $lt: Date } },
      ];
      expect(filter.date.$gte.toISOString()).toBe('2026-09-20T00:00:00.000Z');
      expect(filter.date.$lt.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    });

    it('a Sunday starts its own week and a Saturday ends it', async () => {
      expect((await view('2026-09-20')).weekParam).toBe('2026-09-20');
      expect((await view('2026-09-26')).weekParam).toBe('2026-09-20');
      expect((await view('2026-09-27')).weekParam).toBe('2026-09-27');
    });

    it('puts each entry on the day of its date and drops dates outside the week', async () => {
      entries = [
        entryOn('2026-09-20', 1),
        entryOn('2026-09-23', 2),
        entryOn('2026-09-23', 3),
        entryOn('2026-09-26', 4),
        entryOn('2026-09-27', 5),
        entryOn('2026-09-19', 6),
      ];
      expect(entryIdsByDay(await view('2026-09-23'))).toEqual([
        [1],
        [],
        [],
        [2, 3],
        [],
        [],
        [4],
      ]);
    });
  });

  describe('mini-month grid', () => {
    it('September 2026 (starts on a Tuesday): five rows from Aug 30, the week highlighted', async () => {
      const vm = await view('2026-09-09');
      expect(vm.monthName).toBe('MONTH_SEP');
      expect(vm.year).toBe(2026);
      expect(gridRows(vm)).toEqual([
        '2026-08-30',
        '2026-09-06',
        '2026-09-13',
        '2026-09-20',
        '2026-09-27',
      ]);
      expect(vm.calendarWeeks[0].days.map((d) => d.dayNum)).toEqual([
        30, 31, 1, 2, 3, 4, 5,
      ]);
      expect(vm.calendarWeeks[4].days.map((d) => d.dayNum)).toEqual([
        27, 28, 29, 30, 1, 2, 3,
      ]);
      expect(cellsWith(vm, 'cal-in-week')).toEqual([6, 7, 8, 9, 10, 11, 12]);
      expect(cellsWith(vm, 'cal-out-month')).toEqual([30, 31, 1, 2, 3]);
      expect(vm.prevMonthParam).toBe('2026-08');
      expect(vm.nextMonthParam).toBe('2026-10');
    });

    it('February 2026 (Sunday to Saturday, 28 days) is exactly four rows', async () => {
      const vm = await view('2026-02-11');
      expect(gridRows(vm)).toEqual([
        '2026-02-01',
        '2026-02-08',
        '2026-02-15',
        '2026-02-22',
      ]);
      expect(cellsWith(vm, 'cal-out-month')).toEqual([]);
    });

    it('August 2026 (Saturday the 1st, 31 days) needs six rows', async () => {
      const vm = await view('2026-08-12');
      expect(gridRows(vm)).toEqual([
        '2026-07-26',
        '2026-08-02',
        '2026-08-09',
        '2026-08-16',
        '2026-08-23',
        '2026-08-30',
      ]);
      expect(vm.calendarWeeks[5].days.map((d) => d.dayNum)).toEqual([
        30, 31, 1, 2, 3, 4, 5,
      ]);
    });

    it('month navigation jumps to the current week when it reaches the current month', async () => {
      // Today is 25 Sep 2026; October's "previous month" link is September.
      const vm = await view('2026-10-14');
      expect(vm.prevMonthParam).toBe('2026-09');
      expect(vm.prevMonthWeekParam).toBe('2026-09-20');
      // November 1 2026 is a Sunday: its first row starts on the 1st.
      expect(vm.nextMonthParam).toBe('2026-11');
      expect(vm.nextMonthWeekParam).toBe('2026-11-01');
    });
  });

  describe('year boundary (December to January)', () => {
    it('the week of Dec 27 2026 runs into January', async () => {
      entries = [entryOn('2026-12-31', 1), entryOn('2027-01-01', 2)];
      const vm = await view('2026-12-30');
      expect(vm.weekParam).toBe('2026-12-27');
      expect(dayNums(vm)).toEqual([27, 28, 29, 30, 31, 1, 2]);
      expect(dates(vm)[5]).toBe('2027-01-01');
      expect(entryIdsByDay(vm)).toEqual([[], [], [], [], [1], [2], []]);
      expect(vm.weekLabel).toBe('MONTH_DEC 27 – MONTH_JAN 2, 2027');
      expect(vm.prevWeekParam).toBe('2026-12-20');
      expect(vm.nextWeekParam).toBe('2027-01-03');
    });

    it('a January date finds the week that started in December', async () => {
      expect((await view('2027-01-02')).weekParam).toBe('2026-12-27');
    });

    it('the mini month steps from December 2026 to January 2027 and back', async () => {
      const december = await view('2026-12-30');
      expect(december.monthName).toBe('MONTH_DEC');
      expect(december.year).toBe(2026);
      expect(december.prevMonthParam).toBe('2026-11');
      expect(december.nextMonthParam).toBe('2027-01');
      // Jan 1 2027 is a Friday: its first row starts on Dec 27.
      expect(december.nextMonthWeekParam).toBe('2026-12-27');

      const january = await view('2026-12-30', '2027-01');
      expect(january.monthName).toBe('MONTH_JAN');
      expect(january.year).toBe(2027);
      expect(january.prevMonthParam).toBe('2026-12');
      expect(january.nextMonthParam).toBe('2027-02');
      expect(gridRows(january)[0]).toBe('2026-12-27');
      // The week shown (Dec 27 - Jan 2) is highlighted across both months.
      expect(cellsWith(january, 'cal-in-week')).toEqual([
        27, 28, 29, 30, 31, 1, 2,
      ]);
    });
  });

  describe('leap day', () => {
    it('Feb 29 2028 is a day of its week and holds its entries', async () => {
      entries = [entryOn('2028-02-29', 1), entryOn('2028-03-01', 2)];
      const vm = await view('2028-02-29');
      expect(vm.weekParam).toBe('2028-02-27');
      expect(dates(vm).slice(1, 4)).toEqual([
        '2028-02-28',
        '2028-02-29',
        '2028-03-01',
      ]);
      expect(entryIdsByDay(vm)).toEqual([[], [], [1], [2], [], [], []]);
      expect(vm.weekLabel).toBe('MONTH_FEB 27 – MONTH_MAR 4, 2028');
      expect(vm.calendarWeeks.at(-1)!.days.map((d) => d.dayNum)).toEqual([
        27, 28, 29, 1, 2, 3, 4,
      ]);
    });

    it('a non-leap February goes straight from the 28th to March 1', async () => {
      const vm = await view('2027-03-02');
      expect(vm.weekParam).toBe('2027-02-28');
      expect(dayNums(vm)).toEqual([28, 1, 2, 3, 4, 5, 6]);
    });
  });

  describe('DST transitions in New York', () => {
    // Clocks jump forward at 02:00 on Sunday 8 March 2026.
    it('entries in the spring-forward week land on their days', async () => {
      entries = [entryOn('2026-03-08', 1), entryOn('2026-03-14', 2)];
      expect(entryIdsByDay(await view('2026-03-10'))).toEqual([
        [1],
        [],
        [],
        [],
        [],
        [],
        [2],
      ]);
    });

    // Known bug (docs/audits/2026-09-25-program2, M5 "latent"): findWeek steps the days with local-time setDate, so under a DST zone the spring-forward week repeats Sunday's date and every later column is one day behind.
    it.fails('the spring-forward week shows Mar 8 to Mar 14', async () => {
      const vm = await view('2026-03-10');
      expect(dayNums(vm)).toEqual([8, 9, 10, 11, 12, 13, 14]);
      expect(dates(vm)[6]).toBe('2026-03-14');
    });

    // Clocks fall back at 02:00 on Sunday 1 November 2026.
    it('the fall-back week shows Nov 1 to Nov 7 with its entries', async () => {
      entries = [
        entryOn('2026-11-01', 1),
        entryOn('2026-11-07', 2),
        entryOn('2026-11-08', 3),
      ];
      const vm = await view('2026-11-04');
      expect(vm.weekParam).toBe('2026-11-01');
      expect(dayNums(vm)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(entryIdsByDay(vm)).toEqual([[1], [], [], [], [], [], [2]]);
      expect(vm.nextWeekParam).toBe('2026-11-08');
    });
  });

  describe('today', () => {
    it('highlights today in the week and in the mini month', async () => {
      const vm = await view('2026-09-23');
      expect(vm.today).toBe('2026-09-25');
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

    it('without ?week= shows the current week', async () => {
      expect((await view()).weekParam).toBe('2026-09-20');
      expect((await view('not-a-date')).weekParam).toBe('2026-09-20');
    });

    // The server's zone stands in for the household's here; the audit's fix
    // is one configured zone (APP_TIMEZONE) or the client's date.
    // Known bug (docs/audits/2026-09-25-program2): the calendar computes "today" and the default week in UTC, so evenings in US time zones highlight tomorrow.
    it.fails('at 21:30 on Friday evening, today is still Friday', async () => {
      vi.setSystemTime(new Date('2026-09-25T21:30:00-04:00'));
      const vm = await view('2026-09-23');
      expect(vm.today).toBe('2026-09-25');
      expect(vm.days[5].isToday).toBe(true);
    });

    // Known bug (docs/audits/2026-09-25-program2): the calendar computes "today" and the default week in UTC, so evenings in US time zones highlight tomorrow.
    it.fails(
      'on Saturday evening the default week is still this week',
      async () => {
        vi.setSystemTime(new Date('2026-09-26T21:00:00-04:00'));
        expect((await view()).weekParam).toBe('2026-09-20');
      },
    );
  });
});
