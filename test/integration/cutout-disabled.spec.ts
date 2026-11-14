import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file } from '../../src/db/schema';
import type { Readiness } from '../../src/web/health/checks';
import { fakeRunner } from './cutouts';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  uploadPhoto,
} from './garments';
import {
  asFixture,
  createTestApp,
  type TestApp,
  unescapeHtml,
} from './harness';
import { HX_FRAGMENT } from './pages';

/**
 * CUTOUT_ENABLED=false (#690): uploads start `none` (the original with the
 * mask editor's pencil), nothing is ever queued, and readiness calls the
 * queue disabled. That no model is fetched is boot.spec.ts's: the harness
 * never boots main.ts.
 */
describe('cutouts switched off', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ CUTOUT_ENABLED: 'false' });
  });

  afterAll(() => t?.cleanup());

  it('keeps an upload as taken: none, no job, the pencil and no polling', async () => {
    const id = await createGarment(t, { name: 'Plain shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'none',
      cutoutAttempts: 0,
      cutoutRequestedAt: null,
    });
    const html = unescapeHtml(
      (await t.inject({ method: 'GET', url: `/wardrobe/${id}` })).body,
    );
    expect(html).toContain('id="editMaskBtn"');
    expect(html).not.toContain('Removing background');
    expect(html).not.toContain(`/wardrobe/${id}/cutout?poll=`);
  });

  // Rows from before the switch: shown as none (no spinner, poll or retry),
  // never rewritten, and "Try again" posted by hand changes nothing.
  it.each(['pending', 'failed'] as const)(
    'shows a %s cutout as none and leaves its row alone',
    async (status) => {
      const id = await createGarment(t, { name: `Old ${status}` });
      await uploadPhoto(t, id, await jpegPhoto());
      const fileName = await photoFileName(t, id);
      await asFixture(t.db, (tx) =>
        tx
          .update(file)
          .set({
            cutoutStatus: status,
            cutoutRequestedAt: status === 'pending' ? new Date() : null,
          })
          .where(eq(file.fileName, fileName)),
      );

      for (const url of [`/wardrobe/${id}`, `/wardrobe/${id}/cutout`]) {
        const html = unescapeHtml(
          (await t.inject({ method: 'GET', url, headers: HX_FRAGMENT })).body,
        );
        expect(html).toContain('id="editMaskBtn"');
        expect(html).not.toContain('Removing background');
        expect(html).not.toContain('/cutout?poll=');
        expect(html).not.toContain('/cutout/retry');
      }
      const retry = await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}/cutout/retry`,
      });
      expect(retry.statusCode).toBe(303);
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: status,
      });
    },
  );

  it('refuses a runner and reports the queue disabled, not down', async () => {
    expect(t.cutouts.enabled).toBe(false);
    expect(() => t.cutouts.start(fakeRunner())).toThrow(
      'The cutout queue cannot start while disabled',
    );
    const res = await t.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Readiness>().checks.cutout_queue).toEqual({
      status: 'up',
      required: false,
      disabled: true,
    });
  });
});
