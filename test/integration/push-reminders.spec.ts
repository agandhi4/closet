import { eq } from 'drizzle-orm';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
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
import webpush, { type PushSubscription } from 'web-push';
import { createDb, type Db } from '../../src/db/client';
import { pushReminder, userDevice } from '../../src/db/schema';
import { type MinuteOfDay } from '../../src/push/reminders';
import {
  addDays,
  instantAt,
  type IsoDate,
} from '../../src/web/calendar/calendar-date';
import { parsePushPayload, type PushPayload } from '../../src/web/push/payload';
import { saveReminderSettings } from '../../src/web/push/queries';
import {
  type ReminderDeps,
  pruneReminders,
  sendDueReminders,
} from '../../src/web/push/reminders';
import { createPushSender } from '../../src/web/push/sender';
import { createGarment } from './garments';
import {
  createTestApp,
  PWA_ENV,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectFragment, HX_FRAGMENT } from './pages';

/**
 * The push reminders (#15): each device's settings on the profile, and the
 * scheduler's run (sendDueReminders) at pinned instants: the morning
 * "Today's outfit" and the evening "What did you wear?", both linking to
 * Today, the evening one skipped once something is worn; once per device
 * and day, even with two servers claiming at the same moment; the time a
 * wall-clock time on DST days; a device set after its time waits a day.
 * web-push's sendNotification is stubbed: nothing leaves the process, and
 * each call's plaintext payload is what the device would receive.
 */

interface Sent {
  endpoint: string;
  payload: PushPayload;
  ttl: number | undefined;
}

function subscription(endpoint = newEndpoint()) {
  return {
    endpoint,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function newEndpoint(): string {
  return `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
}

const minute = (hour: number, min = 0): MinuteOfDay => hour * 60 + min;

describe('push reminders', () => {
  let t: TestApp;
  let deps: ReminderDeps;
  let sent: Sent[];

  /** A second past `hour:min` on `day`, in the app's zone. */
  const onTheMinute = (day: IsoDate, hour: number, min = 0) =>
    new Date(instantAt(day, hour, t.timeZone, min).getTime() + 1_000);

  const subscribe = async (cookie?: string) => {
    const sub = subscription();
    const res = await t.inject({
      method: 'POST',
      url: '/push/subscribe',
      payload: sub,
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode).toBe(204);
    return sub.endpoint;
  };

  /** Saves a device's reminders as of `setAt` (the route stamps the real now). */
  const remind = (
    userId: number,
    endpoint: string,
    settings: { morning?: MinuteOfDay; evening?: MinuteOfDay },
    setAt = new Date('2020-01-01T00:00:00Z'),
  ) =>
    saveReminderSettings(
      t.db,
      userId,
      endpoint,
      { morning: settings.morning ?? null, evening: settings.evening ?? null },
      setAt,
    );

  const sentTo = (endpoint: string) =>
    sent.filter((s) => s.endpoint === endpoint);

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
    deps = {
      db: t.db,
      sender: t.push!,
      weather: undefined,
      timeZone: t.timeZone,
      logger: t.logger.child({ context: 'Push' }),
    };
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    sent = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(
      (target: PushSubscription, payload, options) => {
        sent.push({
          endpoint: target.endpoint,
          payload: parsePushPayload(JSON.parse(String(payload)))!,
          ttl: options?.TTL,
        });
        return Promise.resolve({ statusCode: 201, body: '', headers: {} });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never runs in the harness: createApp schedules nothing', () => {
    expect(t.push).toBeDefined();
    expect(
      t.logs.records.some((r) => /Push reminders runs/.test(r.msg ?? '')),
    ).toBe(false);
  });

  describe('the settings, per device', () => {
    const form = (endpoint: string, cookie?: string) =>
      t.inject({
        method: 'POST',
        url: '/push/reminders/form',
        payload: { endpoint },
        headers: { ...HX_FRAGMENT, ...(cookie ? { cookie } : {}) },
      });
    const save = (fields: Record<string, string>, cookie?: string) =>
      t.inject({
        method: 'POST',
        url: '/push/reminders',
        payload: fields,
        headers: { ...HX_FRAGMENT, ...(cookie ? { cookie } : {}) },
      });
    const deviceAt = async (endpoint: string) =>
      (
        await t.db
          .select()
          .from(userDevice)
          .where(eq(userDevice.pushEndpoint, endpoint))
      )[0];

    it('asks to turn notifications on for a device that has none', async () => {
      const res = await form(newEndpoint());
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toContain('Turn notifications on for this device');
    });

    it('starts off, and saves a time with its toggle; both are off by default', async () => {
      const endpoint = await subscribe();
      const blank = unescapeHtml((await form(endpoint)).body);
      expect(blank).toContain('hx-post="/push/reminders"');
      // An AutosaveForm: saves go out in order and answer the status line
      // only (src/web/autosave.tsx).
      expect(blank).toContain('hx-sync="closest form:queue last"');
      expect(blank).toContain('hx-target="find [data-autosave-status]"');
      expect(blank).toContain('data-autosave=""');
      // In the slot push.js loads it into, which keeps its id.
      expect(blank).toContain('<div id="push-reminders" data-show="on"');
      expect(blank).toContain(`name="endpoint" value="${endpoint}"`);
      expect(blank).not.toMatch(/name="(morning|evening)On" value="1" checked/);
      // The defaults are selected, ready for the toggle.
      expect(blank).toMatch(/value="450" selected[^>]*>07:30/);

      t.logs.clear();
      const res = await save({
        endpoint,
        morningOn: '1',
        morning: '420',
        evening: '1260',
      });
      expect(res.statusCode).toBe(200);
      // Only the status line: the controls stay as the person left them.
      expect(res.body).toContain('Saved.');
      expect(res.body).not.toContain('<form');
      // Read again, the form shows what was saved.
      expect(unescapeHtml((await form(endpoint)).body)).toMatch(
        /name="morningOn" value="1" checked/,
      );
      const row = await deviceAt(endpoint);
      expect(row).toMatchObject({
        morningReminder: 420,
        eveningReminder: null,
      });
      expect(row.remindersSetAt).not.toBeNull();
      // Named by device id, never by its endpoint.
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `User ${t.owner.id} set reminders on push device ${row.id}: morning 420, evening off (minutes after midnight)`,
      );
      expect(t.logs.text()).not.toContain(endpoint);
    });

    it('refuses a time off the choices (400)', async () => {
      const endpoint = await subscribe();
      for (const [kind, value] of [
        ['morning', '425'],
        ['morning', '720'],
        ['evening', '420'],
        ['evening', 'late'],
      ]) {
        const res = await save({ endpoint, [`${kind}On`]: '1', [kind]: value });
        expect(res.statusCode, `${kind} ${value}`).toBe(400);
      }
      expect(await deviceAt(endpoint)).toMatchObject({
        morningReminder: null,
        eveningReminder: null,
      });
    });

    it('never touches another account’s device', async () => {
      const cookie = await t.register('reminders-other@example.com');
      const theirs = await subscribe(cookie);
      const res = await save({
        endpoint: theirs,
        morningOn: '1',
        morning: '450',
      });
      expect(res.body).toContain('Turn notifications on for this device');
      expect(await deviceAt(theirs)).toMatchObject({ morningReminder: null });
      expect((await form(theirs)).body).toContain('Turn notifications on');
    });

    it('turns reminders off when the browser signs in as someone else', async () => {
      const endpoint = await subscribe();
      await save({ endpoint, eveningOn: '1', evening: '1260' });
      // The same subscription, sent again by the owner: kept.
      await t.inject({
        method: 'POST',
        url: '/push/subscribe',
        payload: { ...subscription(endpoint) },
      });
      expect(await deviceAt(endpoint)).toMatchObject({ eveningReminder: 1260 });
      const cookie = await t.register('reminders-next@example.com');
      await t.inject({
        method: 'POST',
        url: '/push/subscribe',
        payload: subscription(endpoint),
        headers: { cookie },
      });
      expect(await deviceAt(endpoint)).toMatchObject({
        userId: await userIdOf(t, 'reminders-next@example.com'),
        morningReminder: null,
        eveningReminder: null,
        remindersSetAt: null,
      });
    });

    it('needs a session (401 to a fetch)', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/push/reminders',
        payload: { endpoint: newEndpoint() },
        headers: HX_FRAGMENT,
        anonymous: true,
      });
      expect(res.statusCode).toBe(401);
    });

    it('the profile holds the slot push.js fills once the device is on', async () => {
      const res = await t.inject({ method: 'GET', url: '/auth/profile' });
      expect(res.body).toContain('id="push-reminders" data-show="on" hidden');
    });
  });

  describe('a run', () => {
    // A day of its own per test (claims are per day), never today's real
    // one unless the test marks something worn.
    const DAY = '2030-01-15';

    it('sends the morning reminder at its minute, to the devices that chose it, opening Today', async () => {
      const cookie = await t.register('morning@example.com');
      const userId = await userIdOf(t, 'morning@example.com');
      const [phone, laptop] = [
        await subscribe(cookie),
        await subscribe(cookie),
      ];
      await remind(userId, phone, { morning: minute(7, 30) });
      await remind(userId, laptop, { evening: minute(21) });

      // Every device in the database is the run's: assert on these two.
      await sendDueReminders(deps, onTheMinute(DAY, 7, 29));
      expect(sentTo(phone)).toEqual([]);
      const run = await sendDueReminders(deps, onTheMinute(DAY, 7, 30));
      expect(run.failed).toBe(0);
      expect(sentTo(laptop)).toEqual([]);
      expect(sentTo(phone)).toEqual([
        {
          endpoint: phone,
          payload: {
            title: "Today's outfit",
            body: 'Nothing planned yet. Open Today for ideas.',
            url: '/',
            tag: 'today-morning',
          },
          ttl: 3 * 60 * 60,
        },
      ]);
      expect(t.logs.messages('info', 'Push')).toContainEqual(
        expect.stringMatching(
          /^Reminders at 2030-01-15T12:30:01\.000Z: \d+ claimed of \d+ due, \d+ sent, 0 skipped, 0 failed$/,
        ),
      );
    });

    it('goes out once a device and day: the next minutes and a second run find it claimed', async () => {
      const cookie = await t.register('once@example.com');
      const userId = await userIdOf(t, 'once@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(8) });
      const day = addDays(DAY, 1);
      for (const [hour, min] of [
        [8, 0],
        [8, 0],
        [8, 1],
        [8, 29],
      ]) {
        await sendDueReminders(deps, onTheMinute(day, hour, min));
      }
      expect(sentTo(phone)).toHaveLength(1);
      // The next day, again once.
      await sendDueReminders(deps, onTheMinute(addDays(day, 1), 8));
      expect(sentTo(phone)).toHaveLength(2);
    });

    it('names the day’s plan and, with nothing that dresses the day, the top idea', async () => {
      const cookie = await t.register('planned@example.com');
      const userId = await userIdOf(t, 'planned@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(7), evening: minute(21) });
      const garments = await Promise.all(
        (['tops', 'bottoms', 'footwear'] as const).map((category) =>
          createGarment(t, { name: `Planned ${category}`, category, cookie }),
        ),
      );
      const outfit = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: {
          name: 'Dinner',
          category: ['tops', 'bottoms', 'footwear'],
          garmentId: garments.map(String),
        },
        headers: { cookie },
      });
      const outfitId = /\/outfits\/(\d+)/.exec(
        String(outfit.headers.location),
      )![1];
      const day = addDays(DAY, 5);
      await t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: day, outfitId, occasion: 'evening' },
        headers: { cookie },
      });

      await sendDueReminders(deps, onTheMinute(day, 7));
      const [morning] = sentTo(phone);
      // Only three garments, all in the saved dinner: no idea to add.
      expect(morning.payload.body).toBe('Evening: Dinner');

      await sendDueReminders(deps, onTheMinute(day, 21));
      expect(sentTo(phone)[1].payload).toEqual({
        title: 'What did you wear?',
        body: 'Planned: Evening: Dinner. Tap to mark what you wore.',
        url: '/',
        tag: 'today-evening',
      });
      expect(sentTo(phone)[1].ttl).toBe(60 * 60);
    });

    it('skips the evening reminder once something is marked worn today', async () => {
      const cookie = await t.register('worn@example.com');
      const userId = await userIdOf(t, 'worn@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { evening: minute(22) });
      const today = t.today();
      const tee = await createGarment(t, { name: 'Worn tee', cookie });
      // "Wore today" on the garment page counts as much as an entry.
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${tee}/wear`,
        payload: { worn: '1' },
        headers: { cookie },
      });
      t.logs.clear();
      const run = await sendDueReminders(deps, onTheMinute(today, 22));
      expect(run).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
      expect(sentTo(phone)).toEqual([]);
      expect(t.logs.messages('info', 'Push')).toContain(
        `Evening reminder for user ${userId} skipped: something is marked worn today`,
      );
      // Claimed all the same: undoing the wear later sends nothing today.
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${tee}/wear`,
        payload: { worn: '0' },
        headers: { cookie },
      });
      await sendDueReminders(deps, onTheMinute(today, 22, 5));
      expect(sentTo(phone)).toEqual([]);
    });

    it('waits for tomorrow when the device chose a time already past today', async () => {
      const cookie = await t.register('late@example.com');
      const userId = await userIdOf(t, 'late@example.com');
      const phone = await subscribe(cookie);
      const day = addDays(DAY, 10);
      // Turned on at 08:10 for 08:00.
      await remind(
        userId,
        phone,
        { morning: minute(8) },
        instantAt(day, 8, t.timeZone, 10),
      );
      await sendDueReminders(deps, onTheMinute(day, 8, 10));
      await sendDueReminders(deps, onTheMinute(day, 8, 11));
      expect(sentTo(phone)).toEqual([]);
      await sendDueReminders(deps, onTheMinute(addDays(day, 1), 8));
      expect(sentTo(phone)).toHaveLength(1);
    });

    it('sends at the wall-clock time on both DST days', async () => {
      const cookie = await t.register('dst@example.com');
      const userId = await userIdOf(t, 'dst@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(7, 30) });
      // 2030's US changes: 10 March (spring forward), 3 November (back).
      for (const [day, early, due] of [
        ['2030-03-10', '2030-03-10T10:30:01Z', '2030-03-10T11:30:01Z'],
        ['2030-11-03', '2030-11-03T11:30:01Z', '2030-11-03T12:30:01Z'],
      ]) {
        const before = sentTo(phone).length;
        expect(onTheMinute(day, 7, 30).toISOString()).toBe(
          new Date(due).toISOString(),
        );
        await sendDueReminders(deps, new Date(early));
        expect(sentTo(phone)).toHaveLength(before);
        await sendDueReminders(deps, new Date(due));
        expect(sentTo(phone)).toHaveLength(before + 1);
      }
    });

    it('two servers running the same minute send each reminder once', async () => {
      // A second server of an overlapping deploy: its own pool and sender.
      const logger = t.logger.child({ context: 'Push' });
      const other: Db = createDb(t.database, logger);
      const otherDeps: ReminderDeps = {
        ...deps,
        db: other,
        sender: createPushSender({
          db: other,
          logger,
          vapid: {
            subject: PWA_ENV.SITE_URL,
            publicKey: PWA_ENV.PUBLIC_VAPID_KEY,
            privateKey: PWA_ENV.PRIVATE_VAPID_KEY,
          },
        }),
      };
      try {
        const cookie = await t.register('overlap@example.com');
        const userId = await userIdOf(t, 'overlap@example.com');
        const phones = [
          await subscribe(cookie),
          await subscribe(cookie),
          await subscribe(cookie),
        ];
        for (const phone of phones) {
          await remind(userId, phone, {
            morning: minute(6),
            evening: minute(18),
          });
        }
        const start = '2031-02-01';
        for (let n = 0; n < 10; n += 1) {
          const day = addDays(start, n);
          for (const hour of [6, 18]) {
            const now = onTheMinute(day, hour);
            const runs = await Promise.all([
              sendDueReminders(deps, now),
              sendDueReminders(otherDeps, now),
            ]);
            expect(runs[0].claimed + runs[1].claimed).toBe(phones.length);
          }
        }
        for (const phone of phones) {
          expect(sentTo(phone)).toHaveLength(20);
        }
      } finally {
        await other.$client.end();
      }
    });

    it('prunes the claims of past days', async () => {
      const before = await t.db.$count(pushReminder);
      expect(before).toBeGreaterThan(0);
      await pruneReminders(deps, '2100-01-01');
      expect(await t.db.$count(pushReminder)).toBe(0);
      expect(t.logs.messages('info', 'Push')).toContain(
        `Pruned ${before} reminder claim(s) before 2100-01-01`,
      );
    });
  });
});
