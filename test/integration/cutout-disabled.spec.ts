import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Readiness } from '../../src/web/health/checks';
import { fakeRunner } from './cutouts';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  uploadPhoto,
} from './garments';
import { createTestApp, type TestApp, unescapeHtml } from './harness';

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
