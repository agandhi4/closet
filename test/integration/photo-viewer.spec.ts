import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { optionGroup } from '../../src/db/schema';
import { needUrl } from '../../src/web/wardrobe/urls';
import { markSuggestion } from '../../src/web/wishlist/decisions';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import {
  createGarment,
  createWishlistItem,
  jpegPhoto,
  uploadPhoto,
} from './garments';

/**
 * The shared photo viewer's server side (#313): which photos open which
 * set, and that the set holds exactly the photos the issue names. The
 * viewer's behaviour (open, swipe, zoom, focus, offline) is
 * test/photo-viewer.spec.ts.
 */
describe('the photo viewer markup', () => {
  let t: TestApp;
  const page = async (url: string) =>
    unescapeHtml((await t.inject({ method: 'GET', url })).body);

  /** The `src`s of the photos in a set's template, in swipe order. */
  const setOf = (html: string, id: string) => {
    const start = html.indexOf(`<template data-photo-set="${id}">`);
    expect(start, `set ${id}`).toBeGreaterThan(-1);
    const body = html.slice(start, html.indexOf('</template>', start));
    return [...body.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  };

  const triggers = (html: string, id: string) =>
    [...html.matchAll(new RegExp(`data-photo-open="${id}"[^>]*>`, 'g'))].map(
      (m) => /data-photo-large="([^"]+)"/.exec(m[0])![1],
    );

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it('is on every page once: the dialog with its labels and the script', async () => {
    const html = await page('/');
    expect(html.match(/id="photo-viewer"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Previous photo"');
    expect(html).toContain('aria-label="Next photo"');
    expect(html).toContain('/js/photo-viewer.js');
  });

  it('opens the garment page photo on a set of the cutout then its original', async () => {
    const id = await createGarment(t, { name: 'Boots', category: 'shoes' });
    await uploadPhoto(t, id, await jpegPhoto());
    const html = await page(`/wardrobe/${id}`);
    const set = setOf(html, 'garment-photos');
    expect(set.length).toBeGreaterThanOrEqual(1);
    expect(set.at(-1)).not.toMatch(/-(nobg|thumb)/);
    expect(triggers(html, 'garment-photos')).toHaveLength(1);
    expect(set).toContain(triggers(html, 'garment-photos')[0]);
    expect(html).toContain('aria-label="Enlarge photo of Boots"');
  });

  it('opens a need’s options on their own set, every trigger on a photo of it', async () => {
    const [need] = await t.db
      .insert(optionGroup)
      .values({ ownerId: t.owner.id, name: 'A navy knit', budget: '100' })
      .returning({ id: optionGroup.id });
    for (const name of ['Navy crew', 'Navy cardigan', 'Navy vest']) {
      const id = await createWishlistItem(t, { name, category: 'tops' });
      // The vest has no photo: it is in no set.
      if (name !== 'Navy vest') await uploadPhoto(t, id, await jpegPhoto());
      expect(
        await markSuggestion(t.db, t.owner.id, id, {
          tokenId: null,
          groupId: need.id,
          note: null,
          rank: null,
        }),
      ).toBe('marked');
    }
    const html = await page(needUrl(need.id, undefined));
    const set = setOf(html, 'need-options');
    expect(set).toHaveLength(2);
    const ids = new Set(
      [...html.matchAll(/data-photo-open="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(ids).toContain('need-options');
    for (const id of ids) {
      const own = setOf(html, id);
      for (const src of triggers(html, id)) expect(own).toContain(src);
    }
  });
});
