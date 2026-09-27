import { and, asc, eq, gt } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import {
  outfit,
  outfitCalendar,
  weekPlan,
  weekPlanEntry,
  weekReplan,
  weekTemplate,
} from '../../src/db/schema';
import type { Occasion } from '../../src/wardrobe/occasions';
import {
  addDays,
  instantAt,
  type IsoDate,
} from '../../src/web/calendar/calendar-date';
import type { PushPayload } from '../../src/web/push/payload';
import { saveReminderSettings, upsertDevice } from '../../src/web/push/queries';
import type { PushSender } from '../../src/web/push/sender';
import { setHome } from '../../src/web/weather/queries';
import type { WeatherService } from '../../src/web/weather/service';
import type { DayForecast } from '../../src/weather/forecast';
import {
  planDays,
  planMyWeek,
  type WeekForecast,
} from '../../src/web/week-plan/plan';
import {
  pruneReplans,
  REPLAN_HOUR,
  type ReplanDeps,
  replanWeeks,
} from '../../src/web/week-plan/replan';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { callTool, createAccessToken, tool } from './mcp';
import {
  expectFullPage,
  expectNativePostForms,
  expectNoScriptNavigation,
} from './pages';

/**
 * The weekly auto-plan (#16): the Profile's week template, "Plan my week"
 * (its empty slots filled once, auto entries and their batch, the banner
 * and Undo), editing or wearing an auto entry makes it the person's, the
 * daily re-plan (before its hour nothing; once a day per user whatever the
 * minutes, restarts or servers; auto entries only; a swap pushed to the
 * morning reminder's devices; DST days), and plan_week. The clock is pinned
 * to Monday 5 October 2026, 08:00 in New York, so today's slots are open.
 * The pure rules are src/wardrobe/week-planner.spec.ts's.
 */

type Fields = Record<string, string | string[]>;

const TODAY = '2026-10-05';
const WEEK = planDays(TODAY);

function formPayload(fields: Fields) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

/** A day at `feelsLike` °C every hour, dry. */
function steadyDay(day: IsoDate, feelsLike: number): DayForecast {
  return {
    day,
    code: 1,
    high: feelsLike,
    low: feelsLike,
    precipitationChance: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike,
      precipitationChance: 0,
      code: 1,
    })),
  };
}

function weekAt(feelsLike: (day: IsoDate) => number): DayForecast[] {
  return WEEK.map((day) => steadyDay(day, feelsLike(day)));
}

/** A weather service that answers `days` for any location (the re-plan's). */
function fakeWeather(days: () => DayForecast[]): WeatherService {
  return {
    forecastFor: () =>
      Promise.resolve({
        forecast: { timeZone: 'America/New_York', days: days() },
        fetchedAt: new Date(),
      }),
    searchPlaces: () => Promise.resolve([]),
  };
}

describe('the weekly auto-plan', () => {
  let t: TestApp;
  let coat: number;

  const garmentIn = async (
    name: string,
    category: string,
    color: string,
    extra: Fields = {},
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...formPayload({
        name,
        category,
        props: '1',
        care: '1',
        formality: '2',
        pattern: 'solid',
        color: [color],
        ...extra,
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });
  const post = (url: string, fields: Fields = {}, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      ...formPayload(fields),
      ...(cookie
        ? { headers: { ...formPayload(fields).headers, cookie } }
        : {}),
    });

  /** The owner's entries from today on: [day, occasion, planned_by]. */
  const weekEntries = async (ownerId = t.owner.id) =>
    (
      await t.db
        .select({
          id: outfitCalendar.id,
          day: outfitCalendar.day,
          occasion: outfitCalendar.occasion,
          plannedBy: outfitCalendar.plannedBy,
          outfitId: outfitCalendar.outfitId,
        })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.ownerId, ownerId),
            gt(outfitCalendar.day, addDays(TODAY, -1)),
          ),
        )
        .orderBy(asc(outfitCalendar.day), asc(outfitCalendar.id))
    ).map((e) => ({ ...e, slot: `${e.day} ${e.occasion}` }));

  // Every test starts from the closet alone: the planner never repeats a
  // saved outfit, so the last test's outfits would use up its combinations
  // (a plain delete is fine here: the wears it cascades are the last
  // test's too).
  const clearWeek = async () => {
    await t.db.delete(outfit);
    await t.db.delete(weekPlan);
    await t.db.delete(weekReplan);
  };

  /** Every day all day, and an evening on Tuesdays: 8 slots this week. */
  const TEMPLATE: Fields = {
    'day-0': 'all-day',
    'day-1': 'all-day',
    'day-2': 'all-day',
    'around-2': 'evening',
    'day-3': 'all-day',
    'day-4': 'all-day',
    'day-5': 'all-day',
    'day-6': 'all-day',
  };
  const TEMPLATE_SLOTS = [
    ...WEEK.map((day) => `${day} all-day`),
    '2026-10-06 evening',
  ].sort();

  beforeAll(async () => {
    t = await createTestApp();
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-10-05T12:00:00Z'),
    });
    for (const [i, color] of [
      'white',
      'grey',
      'black',
      'beige',
      'brown',
    ].entries()) {
      await garmentIn(`Tee ${i}`, 'tops', color, { quantity: '3' });
    }
    for (const [i, color] of ['blue', 'black', 'beige'].entries()) {
      await garmentIn(`Trousers ${i}`, 'bottoms', color);
    }
    for (const [i, color] of ['white', 'brown'].entries()) {
      await garmentIn(`Shoes ${i}`, 'footwear', color);
    }
    coat = await garmentIn('Wool coat', 'outerwear', 'black', {
      type: 'coat',
      warmth: '5',
    });
    vi.useRealTimers();
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-10-05T12:00:00Z'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the week template, on the Profile', () => {
    it('shows an empty week, saves it whole, and shows it again', async () => {
      const blank = await get('/auth/profile');
      expectFullPage(blank);
      expectNativePostForms(blank);
      expect(blank.body).toContain('id="week"');
      expect(blank.body).toContain('action="/auth/profile/week"');

      t.logs.clear();
      const res = await post('/auth/profile/week', TEMPLATE);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/profile?weekSaved=1#week');
      const rows = await t.db
        .select({
          weekday: weekTemplate.weekday,
          occasion: weekTemplate.occasion,
        })
        .from(weekTemplate)
        .where(eq(weekTemplate.userId, t.owner.id))
        .orderBy(asc(weekTemplate.weekday), asc(weekTemplate.occasion));
      expect(rows).toHaveLength(8);
      expect(rows).toContainEqual({ weekday: 2, occasion: 'evening' });
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Week template saved by user ${t.owner.id}: 8 slot(s) on 7 day(s)`,
      );

      const page = unescapeHtml((await get('/auth/profile?weekSaved=1')).body);
      expect(page).toContain('Week saved');
      expect(page).toMatch(/name="day-2"[\s\S]*?value="all-day" selected/);
      expect(page).toMatch(/name="around-2" value="evening"[^>]*checked/);
    });

    it('refuses what the week cannot hold: two outfits for one day, an unknown occasion', async () => {
      const refused: Fields[] = [
        { 'around-1': 'work' },
        { 'day-1': 'evening' },
        { 'day-1': 'brunch' },
      ];
      for (const fields of refused) {
        const res = await post('/auth/profile/week', fields);
        expect(res.statusCode).toBe(400);
      }
      expect(
        await t.db.$count(weekTemplate, eq(weekTemplate.userId, t.owner.id)),
      ).toBe(8);
    });

    it('is the user’s own: another user’s profile shows their empty week', async () => {
      const stranger = await t.register('stranger-week@example.com');
      const theirs = unescapeHtml(
        (await get('/auth/profile', { cookie: stranger })).body,
      );
      expect(theirs).not.toMatch(/value="all-day" selected/);
    });
  });

  describe('"Plan my week"', () => {
    beforeEach(clearWeek);

    it('sends someone without a week template to set one, and plans nothing', async () => {
      const cookie = await t.register('no-template@example.com');
      const res = await post('/calendar/plan-week', {}, cookie);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/profile#week');
      expect(await t.db.$count(weekPlan)).toBe(0);
    });

    it('fills every empty slot of the next 7 days with an auto entry, once, and says what it planned', async () => {
      const calendar = await get('/calendar');
      expect(calendar.body).toContain('action="/calendar/plan-week"');

      t.logs.clear();
      const res = await post('/calendar/plan-week');
      expect(res.statusCode).toBe(303);
      const planId = Number(
        /^\/calendar\?planned=(\d+)$/.exec(String(res.headers.location))![1],
      );
      const entries = await weekEntries();
      expect(entries.map((e) => e.slot).sort()).toEqual(TEMPLATE_SLOTS);
      expect(entries.every((e) => e.plannedBy === 'auto')).toBe(true);
      // No outfit twice in the week; each one new, named after its garments.
      expect(new Set(entries.map((e) => e.outfitId)).size).toBe(entries.length);
      const recorded = await t.db
        .select()
        .from(weekPlanEntry)
        .where(eq(weekPlanEntry.weekPlanId, planId));
      expect(recorded).toHaveLength(8);
      // Planned without weather: no targets recorded.
      expect(recorded.every((r) => r.outfitCreated && r.torso === null)).toBe(
        true,
      );
      expect(
        t.logs
          .messages('info', 'Web')
          .some((m) =>
            m.startsWith(
              `Week planned for user ${t.owner.id} from ${TODAY} (plan ${planId}): 8 outfit(s)`,
            ),
          ),
      ).toBe(true);

      // The banner: what was planned, and Undo.
      const banner = await get(String(res.headers.location));
      expectFullPage(banner);
      expectNativePostForms(banner);
      expectNoScriptNavigation(banner);
      const html = unescapeHtml(banner.body);
      expect(html).toContain('Planned 8 outfits for your week');
      expect(html.match(/data-entry-id="/g)).toHaveLength(8);
      expect(html).toContain(`action="/calendar/plan-week/${planId}/undo"`);
      expect(html).not.toContain('data-still-empty');
      // The week's rows say which are the planner's.
      expect(
        (await get('/calendar')).body.match(/data-auto/g)?.length,
      ).toBeGreaterThanOrEqual(1);

      // Again: every slot is filled, so nothing new.
      const again = await post('/calendar/plan-week');
      expect(again.headers.location).toBe('/calendar?planned=none');
      expect(await weekEntries()).toHaveLength(8);
      expect(await t.db.$count(weekPlan)).toBe(1);
      expect(
        unescapeHtml((await get('/calendar?planned=none')).body),
      ).toContain('Nothing new to plan');
    });

    it('leaves slots the person filled, and a day their outfit dresses', async () => {
      await post('/calendar/plan-week');
      const planned = await weekEntries();
      // The outfits stay, saved; the entries go.
      await t.db.delete(outfitCalendar);
      await t.db.delete(weekPlan);
      // The person's own all-day outfit on Wednesday, planned for work.
      const theirs = planned.find((e) => e.day === '2026-10-07')!.outfitId;
      await post('/calendar', {
        date: '2026-10-07',
        outfitId: String(theirs),
        occasion: 'work',
      });
      await post('/calendar/plan-week');
      const entries = await weekEntries();
      expect(entries.filter((e) => e.day === '2026-10-07')).toEqual([
        expect.objectContaining({ occasion: 'work', plannedBy: 'user' }),
      ]);
      expect(entries.filter((e) => e.plannedBy === 'auto')).toHaveLength(7);
    });

    it('two taps at once plan each slot once', async () => {
      const [a, b] = await Promise.all([
        post('/calendar/plan-week'),
        post('/calendar/plan-week'),
      ]);
      expect([a.headers.location, b.headers.location]).toContain(
        '/calendar?planned=none',
      );
      const entries = await weekEntries();
      expect(entries.map((e) => e.slot).sort()).toEqual(TEMPLATE_SLOTS);
    });

    it("leaves today's slots whose window has ended", async () => {
      // 23:30 in New York: today's all-day window (8 to 22) is over.
      vi.setSystemTime(new Date('2026-10-06T03:30:00Z'));
      await post('/calendar/plan-week');
      const slots = (await weekEntries()).map((e) => e.slot);
      expect(slots).not.toContain(`${TODAY} all-day`);
      expect(slots).toContain(`${addDays(TODAY, 6)} all-day`);
    });

    it('dresses each slot for its forecast, and records what it was planned for', async () => {
      const warm = weekAt(() => 24);
      warm[2] = steadyDay(WEEK[2], -2);
      const forecast: WeekForecast = {
        days: new Map(warm.map((d) => [d.day, d])),
        offset: 0,
      };
      const result = await planMyWeek(t.db, t.owner.id, {
        today: TODAY,
        hour: 8,
        days: WEEK,
        forecast,
      });
      const cold = result.planned.find(
        (p) => p.day === WEEK[2] && p.occasion === 'all-day',
      )!;
      expect(cold.garments.map((g) => g.id)).toContain(coat);
      const [row] = await t.db
        .select()
        .from(weekPlanEntry)
        .where(eq(weekPlanEntry.entryId, cold.entryId));
      expect(row.torso).toBeGreaterThanOrEqual(7);
      expect(row.layer).toBe(false);
    });
  });

  describe('an auto entry becomes the person’s', () => {
    beforeEach(clearWeek);

    it('when they edit its outfit, or mark it worn; Undo then leaves it', async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const [todays, tomorrows] = await weekEntries();
      // Worn today.
      const worn = await post(`/calendar/${todays.id}/worn`, { worn: '1' });
      expect(worn.statusCode).toBe(303);
      // Tomorrow's outfit edited (the calendar chip's edit link is the outfit form).
      const slots = await t.db.query.outfitSlot.findMany({
        where: (slot, { eq: equals }) =>
          equals(slot.outfitId, tomorrows.outfitId),
      });
      t.logs.clear();
      const edit = await post(`/outfits/${tomorrows.outfitId}`, {
        name: 'My Tuesday',
        category: slots.map((s) => s.category),
        garmentId: slots.map((s) => String(s.garmentId)),
      });
      expect(edit.statusCode).toBe(302);
      expect(
        t.logs
          .messages('info', 'Web')
          .some((m) => m.includes("1 planned entry(ies) now the user's")),
      ).toBe(true);
      const byId = new Map((await weekEntries()).map((e) => [e.id, e]));
      expect(byId.get(todays.id)!.plannedBy).toBe('user');
      expect(byId.get(tomorrows.id)!.plannedBy).toBe('user');

      // Undo removes the rest and the outfits it made for them.
      const outfitsBefore = await t.db.$count(outfit);
      const undo = await post(`/calendar/plan-week/${planId}/undo`);
      expect(undo.statusCode).toBe(303);
      expect(undo.headers.location).toBe('/calendar?undone=6');
      const left = await weekEntries();
      expect(left.map((e) => e.id).sort()).toEqual(
        [todays.id, tomorrows.id].sort(),
      );
      expect(await t.db.$count(outfit)).toBe(outfitsBefore - 6);
      // The batch stays: two of its entries are still on the calendar.
      expect(await t.db.$count(weekPlan)).toBe(1);
      expect(unescapeHtml((await get('/calendar?undone=6')).body)).toContain(
        'Plan undone: 6 removed',
      );
    });

    it("refuses another user's plan", async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const stranger = await t.register('stranger-undo@example.com');
      const undo = await post(
        `/calendar/plan-week/${planId}/undo`,
        {},
        stranger,
      );
      expect(undo.statusCode).toBe(404);
      expect(await weekEntries()).toHaveLength(8);
      // Their calendar shows no banner for it either.
      const banner = await get(`/calendar?planned=${planId}`, {
        cookie: stranger,
      });
      expect(banner.body).not.toContain('id="planned-week"');
    });
  });

  describe('the daily re-plan', () => {
    let sends: {
      userId: number;
      deviceIds: readonly number[];
      payload: PushPayload;
      ttl: number;
    }[];
    let forecastDays: DayForecast[];
    let deps: ReplanDeps;
    const push: PushSender = {
      sendToUser: () => Promise.reject(new Error('not used')),
      sendToDevices: (userId, deviceIds, payload, options) => {
        sends.push({ userId, deviceIds, payload, ttl: options.ttlSeconds });
        return Promise.resolve({
          devices: deviceIds.length,
          delivered: deviceIds.length,
          pruned: 0,
          failed: 0,
        });
      },
    };
    /** `hour`:01 on `day` in the app's zone. */
    const at = (day: IsoDate, hour: number) =>
      new Date(instantAt(day, hour, t.timeZone).getTime() + 60_000);

    /** "Plan my week" under a warm week, as the person did yesterday. */
    const planWarm = () =>
      planMyWeek(t.db, t.owner.id, {
        today: TODAY,
        hour: 8,
        days: WEEK,
        forecast: {
          days: new Map(weekAt(() => 24).map((d) => [d.day, d])),
          offset: 0,
        },
      });

    beforeAll(async () => {
      await setHome(t.db, t.owner.id, {
        name: 'Fort Greene',
        location: { latitude: 40.69, longitude: -73.98 },
      });
      const deviceId = await upsertDevice(
        t.db,
        t.owner.id,
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/week-replan',
          keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
        },
        undefined,
      );
      await saveReminderSettings(
        t.db,
        t.owner.id,
        'https://fcm.googleapis.com/fcm/send/week-replan',
        { morning: 450, evening: null },
        new Date('2020-01-01T00:00:00Z'),
      );
      expect(deviceId).toBeGreaterThan(0);
    });

    beforeEach(async () => {
      await clearWeek();
      sends = [];
      forecastDays = weekAt(() => 24);
      deps = {
        db: t.db,
        weather: fakeWeather(() => forecastDays),
        push,
        timeZone: t.timeZone,
        logger: t.logger.child({ context: 'WeekPlan' }),
      };
    });

    it('never runs in the harness: createApp schedules nothing', () => {
      expect(
        t.logs.records.some((r) => /Week re-plan runs/.test(r.msg ?? '')),
      ).toBe(false);
    });

    it(`does nothing before ${REPLAN_HOUR}:00, then keeps entries whose targets did not change`, async () => {
      await planWarm();
      expect(await replanWeeks(deps, at(TODAY, REPLAN_HOUR - 1))).toMatchObject(
        { claimed: 0 },
      );
      expect(await t.db.$count(weekReplan)).toBe(0);
      const run = await replanWeeks(deps, at(TODAY, REPLAN_HOUR));
      expect(run).toEqual({
        claimed: 1,
        swapped: 0,
        kept: 0,
        failed: 0,
        pushed: 0,
      });
      expect(sends).toEqual([]);
    });

    it('swaps an auto entry the colder forecast finds too light, and tells the morning reminder’s device', async () => {
      await planWarm();
      const before = await weekEntries();
      forecastDays = weekAt((day) => (day === WEEK[3] ? -2 : 24));
      t.logs.clear();
      const run = await replanWeeks(deps, at(TODAY, 7));
      expect(run).toMatchObject({
        claimed: 1,
        swapped: 1,
        failed: 0,
        pushed: 1,
      });
      const after = await weekEntries();
      const thursday = after.filter((e) => e.day === WEEK[3]);
      expect(thursday).toHaveLength(1);
      expect(thursday[0].plannedBy).toBe('auto');
      const oldThursday = before.find((e) => e.day === WEEK[3])!;
      expect(thursday[0].outfitId).not.toBe(oldThursday.outfitId);
      // The planner's old outfit went with its entry; the new one has the coat.
      expect(
        await t.db.$count(outfit, eq(outfit.id, oldThursday.outfitId)),
      ).toBe(0);
      const coatIn = await t.db.query.outfitSlot.findMany({
        where: (slot, { eq: equals }) =>
          equals(slot.outfitId, thursday[0].outfitId),
      });
      expect(coatIn.map((s) => s.garmentId)).toContain(coat);
      // Every other entry is as it was.
      expect(after.filter((e) => e.day !== WEEK[3]).map((e) => e.id)).toEqual(
        before.filter((e) => e.day !== WEEK[3]).map((e) => e.id),
      );
      expect(sends).toHaveLength(1);
      expect(sends[0].payload).toMatchObject({
        title: 'Your week changed',
        url: '/calendar',
        tag: 'week-replan',
      });
      expect(sends[0].payload.body).toMatch(
        /^Thursday turned cold: swapped in Wool coat/,
      );
      expect(sends[0].ttl).toBe(6 * 60 * 60);
      expect(
        t.logs
          .messages('info', 'WeekPlan')
          .some((m) =>
            m.startsWith(
              `Week re-plan for user ${t.owner.id} on ${TODAY}: 1 swapped (${WEEK[3]} all-day colder)`,
            ),
          ),
      ).toBe(true);
    });

    it("is idempotent: once a day per user, whatever the minutes, and never touches the person's entries", async () => {
      await planWarm();
      const entries = await weekEntries();
      // Thursday's is theirs now (worn is only for today; an edit does it).
      await t.db
        .update(outfitCalendar)
        .set({ plannedBy: 'user' })
        .where(
          eq(outfitCalendar.id, entries.find((e) => e.day === WEEK[3])!.id),
        );
      forecastDays = weekAt(() => -2);
      const first = await replanWeeks(deps, at(TODAY, 7));
      expect(first.claimed).toBe(1);
      const after = await weekEntries();
      expect(after.find((e) => e.day === WEEK[3])).toMatchObject({
        id: entries.find((e) => e.day === WEEK[3])!.id,
        plannedBy: 'user',
      });
      const again = await replanWeeks(
        deps,
        new Date(at(TODAY, 7).getTime() + 60_000),
      );
      expect(again).toEqual({
        claimed: 0,
        swapped: 0,
        kept: 0,
        failed: 0,
        pushed: 0,
      });
      expect(await weekEntries()).toEqual(after);
      expect(sends).toHaveLength(1);
      // The next day is a new claim.
      expect((await replanWeeks(deps, at(addDays(TODAY, 1), 7))).claimed).toBe(
        1,
      );
    });

    it('two servers re-planning the same minute claim each user once', async () => {
      await planWarm();
      forecastDays = weekAt(() => -2);
      const logger = t.logger.child({ context: 'WeekPlan' });
      const other: Db = createDb(t.database, logger);
      try {
        const runs = await Promise.all([
          replanWeeks(deps, at(TODAY, 7)),
          replanWeeks({ ...deps, db: other }, at(TODAY, 7)),
        ]);
        expect(runs.map((r) => r.claimed).sort()).toEqual([0, 1]);
        expect(sends).toHaveLength(1);
        // Each slot still holds one entry.
        expect((await weekEntries()).map((e) => e.slot).sort()).toEqual(
          TEMPLATE_SLOTS,
        );
      } finally {
        await other.$client.end();
      }
    });

    it('runs at its wall-clock hour on the days DST ends and starts', async () => {
      await planWarm();
      for (const [day, utcHour] of [
        // 1 Nov 2026: New York falls back; 06:00 is 11:00 UTC.
        ['2026-11-01', 11],
        // 14 Mar 2027: springs forward; 06:00 is 10:00 UTC.
        ['2027-03-14', 10],
      ] as const) {
        await t.db.insert(outfitCalendar).values({
          ownerId: t.owner.id,
          outfitId: (
            await t.db.select({ id: outfit.id }).from(outfit).limit(1)
          )[0].id,
          day,
          occasion: 'evening',
          plannedBy: 'auto',
        });
        const early = new Date(
          `${day}T${String(utcHour - 1).padStart(2, '0')}:30:00Z`,
        );
        expect((await replanWeeks(deps, early)).claimed).toBe(0);
        const onTime = new Date(
          `${day}T${String(utcHour).padStart(2, '0')}:00:30Z`,
        );
        expect((await replanWeeks(deps, onTime)).claimed).toBe(1);
      }
    });

    it('prunes the claims of past days', async () => {
      await planWarm();
      await replanWeeks(deps, at(TODAY, 7));
      await pruneReplans(deps, TODAY);
      expect(await t.db.$count(weekReplan)).toBe(1);
      await pruneReplans(deps, addDays(TODAY, 1));
      expect(await t.db.$count(weekReplan)).toBe(0);
    });
  });

  describe('plan_week (MCP)', () => {
    beforeEach(clearWeek);

    it('plans the week as the calendar does, and a retry plans nothing new', async () => {
      const token = await createAccessToken(t);
      const answer = await tool<{
        templateSet: boolean;
        weekPlanId: number;
        planned: { day: string; occasion: Occasion; outfit: { id: number } }[];
        unfilled: unknown[];
      }>(t, token, 'plan_week');
      expect(answer.templateSet).toBe(true);
      expect(
        answer.planned.map((p) => `${p.day} ${p.occasion}`).sort(),
      ).toEqual(TEMPLATE_SLOTS);
      expect(answer.unfilled).toEqual([]);
      const retry = await callTool(t, token, 'plan_week');
      expect(retry.value).toMatchObject({ weekPlanId: null, planned: [] });
      expect(await weekEntries()).toHaveLength(8);
      const calendar = await tool<{ entries: { plannedBy: string }[] }>(
        t,
        token,
        'get_calendar',
        { from: TODAY, to: addDays(TODAY, 6) },
      );
      expect(calendar.entries.every((e) => e.plannedBy === 'auto')).toBe(true);
    });
  });

  it('offers "Plan my week" on Today', async () => {
    const today = await get('/');
    expect(today.body).toContain('action="/calendar/plan-week"');
  });
});
