import { describe, expect, it } from 'vitest';
import type { Occasion } from '../../wardrobe/occasions';
import type { TemplateSlot } from '../../wardrobe/week';
import {
  dateParts,
  parseIsoDate,
  todayIn,
  type IsoDate,
  type YearMonth,
} from '../../calendar-date';
import {
  buildCalendarView,
  buildMonthView,
  type CalendarEntry,
  type EntryGarment,
  entryPieces,
  type CalendarView,
  monthRange,
  type MonthView,
  weekOf,
} from './calendar-view';

/**
 * The calendar page's date logic, as GET /calendar runs it (src/web/calendar/
 * routes.tsx): the week around ?week= (or today), the seven days and where
 * entries land, the template's open slots, the month grid (GET
 * /calendar/month), month and year boundaries, leap day,
 * both 2026 DST transitions, and "today" in the household's zone. Runs in
 * America/New_York (the `unit-new-york` project) because a DST zone is where
 * a hidden dependency on the process's zone would show.
 */

const ZONE = 'America/New_York';
/** Friday 25 Sep 2026 in New York. */
const TODAY = '2026-09-25';

function entryOn(
  day: IsoDate,
  id: number,
  occasion: Occasion = 'all-day',
): CalendarEntry {
  return {
    id,
    day,
    occasion,
    worn: false,
    selfie: null,
    plannedBy: 'user',
    outfit: { id, name: `Outfit ${id}`, garments: [] },
  };
}

/** What the route renders for ?week=, given today. */
function view(
  week?: string,
  options: {
    entries?: CalendarEntry[];
    template?: TemplateSlot[];
    today?: IsoDate;
  } = {},
): CalendarView {
  const today = options.today ?? TODAY;
  return buildCalendarView({
    weekStart: weekOf(parseIsoDate(week) ?? today).start,
    today,
    entries: options.entries ?? [],
    template: options.template,
  });
}

/** What GET /calendar/month renders for a month, given today. */
function month(
  of: YearMonth,
  options: { entries?: CalendarEntry[]; today?: IsoDate } = {},
): MonthView {
  return buildMonthView({
    month: of,
    today: options.today ?? TODAY,
    entries: options.entries ?? [],
  });
}

const dates = (vm: CalendarView) => vm.days.map((d) => d.date);
const dayNums = (vm: CalendarView) => vm.days.map((d) => dateParts(d.date).day);
const entryIdsByDay = (vm: CalendarView) =>
  vm.days.map((d) => d.entries.map((e) => e.id));
/** A month's rows as day numbers, 0 for a day of another month. */
const gridDays = (vm: MonthView) =>
  vm.weeks.map((week) => week.map((day) => day?.dayNum ?? 0));

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

    it("stacks a day's entries in occasion order, keeping the read order within one", () => {
      const entries = [
        entryOn('2026-09-23', 1, 'evening'),
        entryOn('2026-09-23', 2, 'work'),
        entryOn('2026-09-23', 3, 'night-out'),
        entryOn('2026-09-23', 4, 'workout'),
        entryOn('2026-09-23', 5, 'evening'),
        entryOn('2026-09-23', 6),
        entryOn('2026-09-24', 7, 'evening'),
        entryOn('2026-09-24', 8, 'daytime'),
      ];
      const vm = view('2026-09-23', { entries });
      expect(entryIdsByDay(vm).slice(3, 5)).toEqual([
        [6, 4, 2, 1, 5, 3],
        [8, 7],
      ]);
      expect(vm.days[3].entries.map((e) => e.occasion)).toEqual([
        'all-day',
        'workout',
        'work',
        'evening',
        'evening',
        'night-out',
      ]);
    });

    it('puts each selfie kept after its outfit was deleted on its own day', () => {
      const look = (id: number, day: IsoDate) => ({
        id,
        day,
        photo: { fileName: `${id}.webp`, version: 1 },
      });
      const vm = buildCalendarView({
        weekStart: '2026-09-20',
        today: TODAY,
        entries: [],
        looks: [
          look(1, '2026-09-22'),
          look(2, '2026-09-22'),
          look(3, '2026-09-26'),
        ],
      });
      expect(vm.days.map((d) => d.looks.map((l) => l.id))).toEqual([
        [],
        [],
        [1, 2],
        [],
        [],
        [],
        [3],
      ]);
    });
  });

  describe('week navigation', () => {
    it('steps a week back and forward from its Sunday', () => {
      const vm = view('2026-09-23');
      expect(vm.prevWeek).toBe('2026-09-13');
      expect(vm.nextWeek).toBe('2026-09-27');
    });
  });

  describe("the template's open slots (#16)", () => {
    // Weekdays work, with a Monday and Thursday run; Friday an evening;
    // Saturday daytime.
    const template: TemplateSlot[] = [
      { weekday: 1, occasion: 'work' },
      { weekday: 2, occasion: 'work' },
      { weekday: 3, occasion: 'work' },
      { weekday: 4, occasion: 'work' },
      { weekday: 5, occasion: 'work' },
      { weekday: 1, occasion: 'workout' },
      { weekday: 4, occasion: 'workout' },
      { weekday: 5, occasion: 'evening' },
      { weekday: 6, occasion: 'daytime' },
    ];
    const slots = (vm: CalendarView) => vm.days.map((d) => d.openSlots);

    it('lists what today and the days after it still need, in occasion order', () => {
      // Today is Friday the 25th: the days before it are history.
      expect(slots(view('2026-09-23', { template }))).toEqual([
        [],
        [],
        [],
        [],
        [],
        ['work', 'evening'],
        ['daytime'],
      ]);
      expect(slots(view('2026-09-27', { template }))[1]).toEqual([
        'workout',
        'work',
      ]);
    });

    it("an entry fills its occasion's slot, and any day occasion the day's", () => {
      const entries = [
        entryOn('2026-09-25', 1, 'evening'),
        entryOn('2026-09-26', 2, 'all-day'),
      ];
      expect(slots(view('2026-09-23', { template, entries })).slice(5)).toEqual(
        [['work'], []],
      );
    });

    it("keeps all of today's slots whatever the hour: the page is the same all day", () => {
      const vm = view('2026-09-27', { template, today: '2026-09-28' });
      expect(vm.days[1].openSlots).toEqual(['workout', 'work']);
    });

    it('none without a template', () => {
      expect(slots(view('2026-09-27')).flat()).toEqual([]);
    });
  });

  describe('month grid', () => {
    it('September 2026 (starts on a Tuesday): five rows, the days around it blank', () => {
      const vm = month({ year: 2026, month: 9 });
      expect(gridDays(vm)).toEqual([
        [0, 0, 1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10, 11, 12],
        [13, 14, 15, 16, 17, 18, 19],
        [20, 21, 22, 23, 24, 25, 26],
        [27, 28, 29, 30, 0, 0, 0],
      ]);
      expect(vm.prev).toBe('2026-08');
      expect(vm.next).toBe('2026-10');
      expect(monthRange(vm.month)).toEqual({
        first: '2026-09-01',
        last: '2026-09-30',
      });
    });

    it('February 2026 (Sunday to Saturday, 28 days) is exactly four rows', () => {
      const vm = month({ year: 2026, month: 2 });
      expect(gridDays(vm)).toHaveLength(4);
      expect(gridDays(vm).flat()).not.toContain(0);
    });

    it('August 2026 (Saturday the 1st, 31 days) needs six rows', () => {
      const vm = month({ year: 2026, month: 8 });
      expect(gridDays(vm)).toHaveLength(6);
      expect(gridDays(vm)[0]).toEqual([0, 0, 0, 0, 0, 0, 1]);
      expect(gridDays(vm)[5]).toEqual([30, 31, 0, 0, 0, 0, 0]);
    });

    it('puts entries on their days in occasion order, today marked', () => {
      const entries = [
        entryOn('2026-09-03', 1, 'evening'),
        entryOn('2026-09-03', 2, 'workout'),
        entryOn('2026-09-25', 3),
        entryOn('2026-10-01', 4),
      ];
      const days = month({ year: 2026, month: 9 }, { entries })
        .weeks.flat()
        .filter((day) => day !== null);
      expect(days).toHaveLength(30);
      expect(days[2].entries.map((e) => e.id)).toEqual([2, 1]);
      expect(days[24].entries.map((e) => e.id)).toEqual([3]);
      expect(days.filter((d) => d.isToday).map((d) => d.date)).toEqual([
        '2026-09-25',
      ]);
      expect(days.flatMap((d) => d.entries.map((e) => e.id))).not.toContain(4);
    });

    // Sixteen forecast days from Friday 25 September end on 10 October.
    it("keeps room for the weather on the forecast's days alone (#201)", () => {
      const inForecast = (vm: MonthView) =>
        vm.weeks
          .flat()
          .filter((day) => day?.inForecast)
          .map((day) => day!.date);

      const september = month({ year: 2026, month: 9 });
      expect(september.forecast).toEqual({
        from: '2026-09-25',
        to: '2026-09-30',
      });
      expect(inForecast(september)).toEqual([
        '2026-09-25',
        '2026-09-26',
        '2026-09-27',
        '2026-09-28',
        '2026-09-29',
        '2026-09-30',
      ]);

      const october = month({ year: 2026, month: 10 });
      expect(october.forecast).toEqual({
        from: '2026-10-01',
        to: '2026-10-10',
      });
      expect(inForecast(october)).toHaveLength(10);

      for (const outside of [
        month({ year: 2026, month: 8 }),
        month({ year: 2026, month: 11 }),
      ]) {
        expect(outside.forecast).toBeNull();
        expect(inForecast(outside)).toEqual([]);
      }

      // The last day of a month: that day alone, then the next month's.
      expect(
        month({ year: 2026, month: 9 }, { today: '2026-09-30' }).forecast,
      ).toEqual({ from: '2026-09-30', to: '2026-09-30' });
      expect(
        month({ year: 2026, month: 10 }, { today: '2026-09-30' }).forecast,
      ).toEqual({ from: '2026-10-01', to: '2026-10-15' });
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

    it('the weeks and months step from December 2026 to January 2027 and back', () => {
      expect(view('2026-12-30').nextWeek).toBe('2027-01-03');
      expect(view('2027-01-05').prevWeek).toBe('2026-12-27');
      const december = month({ year: 2026, month: 12 });
      expect(december.prev).toBe('2026-11');
      expect(december.next).toBe('2027-01');
      const january = month({ year: 2027, month: 1 });
      expect(january.prev).toBe('2026-12');
      // Jan 1 2027 is a Friday.
      expect(gridDays(january)[0]).toEqual([0, 0, 0, 0, 0, 1, 2]);
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
      expect(gridDays(month({ year: 2028, month: 2 })).at(-1)).toEqual([
        27, 28, 29, 0, 0, 0, 0,
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
    it('highlights today in the week', () => {
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
    });

    it('marks the days after today, which cannot be worn yet', () => {
      const vm = view('2026-09-23');
      expect(vm.days.map((d) => d.isFuture)).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
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

/**
 * An entry's collage warns about its unavailable pieces (#358) only while
 * the owner may still wear it: not worn, today or later.
 */
describe('entryPieces', () => {
  const today = '2026-10-09' as IsoDate;
  const piece = (over: Partial<EntryGarment>): EntryGarment => ({
    id: 1,
    name: null,
    category: 'tops',
    photo: null,
    status: 'closet',
    away: null,
    needsWash: false,
    ...over,
  });
  const marksOf = (day: string, worn: boolean, garments: EntryGarment[]) =>
    entryPieces(
      { day, worn, outfit: { id: 1, name: null, garments } },
      today,
    ).map((p) => p.marks);
  const lent = piece({ away: 'lent' });
  const archived = piece({ id: 2, status: 'archived' });
  const dirty = piece({ id: 3, needsWash: true });

  it('marks what blocks an unworn entry today or later', () => {
    expect(marksOf(today, false, [lent, archived, dirty])).toEqual([
      ['away:lent'],
      ['archived'],
      ['needs-wash'],
    ]);
    expect(marksOf('2026-10-12', false, [lent, archived])).toEqual([
      ['away:lent'],
      ['archived'],
    ]);
  });

  it('marks nothing on a worn or past entry', () => {
    expect(marksOf(today, true, [lent, archived, dirty])).toEqual([[], [], []]);
    expect(marksOf('2026-10-08', false, [lent, archived])).toEqual([[], []]);
  });
});
