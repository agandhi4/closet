import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { t as text } from '../../src/web/i18n';
import { createGarment } from './garments';
import { createTestApp, type TestApp } from './harness';
import {
  expectErrorPage,
  expectFailureTrigger,
  HX_BOOSTED,
  HX_FRAGMENT,
} from './pages';

/**
 * One channel for a failed htmx request (#642, the root error handler in
 * src/web/errors.tsx): a fragment request gets its status, no body and an
 * `HX-Trigger` with the message and request id, whatever refused it (a
 * route's refusal, the rate limiter, the owner lock, a crash); a boosted
 * tap gets the error page, which public/js/request-failures.js swaps in.
 */
describe('htmx request failures', () => {
  let t: TestApp;
  let tee: number;

  beforeAll(async () => {
    t = await createTestApp();
    tee = await createGarment(t, { name: 'Failing tee' });
  });

  afterAll(() => t?.cleanup());

  const condition = (id: number) =>
    t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/condition`,
      payload: { condition: 'needs_repair' },
      headers: HX_FRAGMENT,
    });

  /** Runs `request` while a trigger on garment updates raises `errcode`. */
  async function whileUpdatesRaise<T>(
    errcode: string,
    request: () => Promise<T>,
  ): Promise<T> {
    await t.db.execute(
      sql.raw(`create function refuse_update() returns trigger language plpgsql as
        $$ begin raise exception 'refused by the spec' using errcode = '${errcode}'; end $$`),
    );
    await t.db.execute(
      sql`create trigger refuse_update before update on garment for each row execute function refuse_update()`,
    );
    return request().finally(async () => {
      await t.db.execute(sql`drop trigger refuse_update on garment`);
      await t.db.execute(sql`drop function refuse_update()`);
    });
  }

  it.each([
    {
      status: 404,
      message: () => text('refusal.notFound.garment'),
      send: () => condition(999_999),
    },
    {
      status: 409,
      // garment-actions.ts's STATUS_REFUSED, not yet in the catalog.
      message: () => 'Only a garment in the closet can be archived',
      send: async () => {
        const archive = () =>
          t.inject({
            method: 'POST',
            url: `/wardrobe/${tee}/archive`,
            headers: HX_FRAGMENT,
          });
        await archive();
        const again = await archive();
        await t.inject({ method: 'POST', url: `/wardrobe/${tee}/restore` });
        return again;
      },
    },
    {
      status: 429,
      message: () => /^Too many attempts\. Try again in /,
      send: async () => {
        const choose = () =>
          t.inject({
            method: 'POST',
            url: '/wardrobe/new/from-link/photo',
            payload: { url: '' },
            headers: HX_FRAGMENT,
          });
        for (let i = 0; i < 10; i++) await choose();
        return choose();
      },
    },
    {
      // The owner lock's wait (55P03), whichever writer took it.
      status: 503,
      message: () => text('WARDROBE_BUSY'),
      send: () => whileUpdatesRaise('55P03', () => condition(tee)),
    },
    {
      // A crash: the fixed message, never the error's text.
      status: 500,
      message: () => text('refusal.INTERNAL'),
      send: () => whileUpdatesRaise('P0001', () => condition(tee)),
    },
  ] satisfies {
    status: number;
    message: () => string | RegExp;
    send: () => ReturnType<TestApp['inject']>;
  }[])(
    'answers a fragment request refused $status with the trigger and no page',
    async ({ status, message, send }) => {
      expectFailureTrigger(await send(), status, message());
    },
  );

  it('answers a boosted tap on a missing garment with the error page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe/999999',
      headers: HX_BOOSTED,
    });
    expectErrorPage(res, 404, text('refusal.notFound.garment'));
  });
});
