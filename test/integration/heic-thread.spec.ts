import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t as text } from '../../src/web/i18n';
import { createGarment, garmentRow } from './garments';
import {
  createTestApp,
  multipart,
  type TestApp,
  unescapeHtml,
} from './harness';
import { html, type LinkSites, startLinkSites } from './link-sites';

/**
 * HEIC decoding runs on HeicDecoder's thread, never the event loop (#699).
 * The thread here is the stub (test/support/heic-stub-worker.ts), steered
 * by the uploaded bytes: it blocks its own thread, hangs or crashes on cue,
 * so each case is deterministic. The real decoder on a real HEIC is
 * heic-real.spec.ts; the decoder's own rules are heic-decoder.spec.ts.
 */
describe('HEIC decoding off the event loop', () => {
  let t: TestApp;
  let sites: LinkSites;
  const DEADLINE_MS = 1500;

  const uploadHeic = async (garmentId: number, command: string) => {
    const body = await multipart(
      {},
      {
        photo: {
          data: Buffer.from(command),
          filename: 'IMG_0042.HEIC',
          contentType: 'image/heic',
        },
      },
    );
    return t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
  };

  /** What the decoder decoded since the logs were cleared (Photos' debug line). */
  const decodedLines = () =>
    t.logs
      .messages('debug', 'Photos')
      .filter((line) => line.startsWith('Decoded HEIC'));

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp(
      { LOG_LEVEL: 'debug' },
      {
        outboundFetch: sites.outboundFetch,
        heicDecoder: {
          workerPath: join(__dirname, '../support/heic-stub-worker.ts'),
          deadlineMs: DEADLINE_MS,
        },
      },
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('answers /health/live within 100 ms while a large HEIC decodes', async () => {
    const garmentId = await createGarment(t, { name: 'From an iPhone' });
    let settled = false;
    // The stub blocks its own thread for a second: a big decode, on cue.
    const upload = uploadHeic(garmentId, 'block:1000').finally(() => {
      settled = true;
    });

    for (let probe = 0; probe < 6; probe++) {
      const startedAt = performance.now();
      const live = await t.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);
      expect(performance.now() - startedAt).toBeLessThan(100);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Every probe landed while the decode was still running.
    expect(settled).toBe(false);
    expect((await upload).statusCode).toBe(303);
    expect((await garmentRow(t, garmentId))?.photo).not.toBeNull();
  });

  it.each([
    ['passes its deadline', 'hang'],
    ['crashes its thread', 'crash'],
  ])(
    'a decode that %s is the bad-photo 400, and the next HEIC decodes',
    async (_label, command) => {
      const garmentId = await createGarment(t, { name: command });
      t.logs.clear();

      const refused = await uploadHeic(garmentId, command);
      expect(refused.statusCode).toBe(400);
      expect(unescapeHtml(refused.body)).toContain('Unreadable image');
      expect(t.logs.messages('warn', 'Photos')).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Rejected undecodable HEIC upload'),
        ]),
      );
      expect((await garmentRow(t, garmentId))?.photo).toBeNull();

      expect((await uploadHeic(garmentId, 'ok')).statusCode).toBe(303);
    },
    DEADLINE_MS + 5_000,
  );

  it('never decodes a HEIC from a link, whatever its type or name', async () => {
    sites.serve('/img/look.heic', { type: 'image/heic', body: 'ok' });
    sites.serve('/img/look2.heic', {
      type: 'application/octet-stream',
      body: 'ok',
    });
    sites.serve(
      '/products/heic-only',
      html(`<html><head><meta property="og:title" content="Linen Shirt">
        <meta property="og:image" content="/img/look.heic"></head></html>`),
    );
    t.logs.clear();

    for (const path of ['/img/look.heic', '/img/look2.heic']) {
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe/new/from-link',
        payload: { url: sites.url(path) },
      });
      expect(res.statusCode).toBe(502);
      expect(unescapeHtml(res.body)).toContain(
        text('linkImport.UNEXPECTED_CONTENT_TYPE'),
      );
    }
    // A page naming only a HEIC opens the form with no photo to choose.
    const page = await t.inject({
      method: 'POST',
      url: '/wardrobe/new/from-link',
      payload: { url: sites.url('/products/heic-only') },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('name="linkPhoto"');
    expect(decodedLines()).toEqual([]);
    expect(t.logs.messages('warn', 'Photos')).toEqual([]);
  });
});
