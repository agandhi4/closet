import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeCandidates } from '../../src/web/plans/candidates';
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
  const post = (url: string, payload: object) =>
    t.inject({ method: 'POST', url, payload });
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

  it('opens a plan item card and its sheet on the item’s candidates', async () => {
    const created = await post('/wardrobe/plans', {
      name: 'Capsule',
      notes: '',
    });
    const planId = Number(
      /^\/wardrobe\/plans\/(\d+)\?/.exec(String(created.headers.location))![1],
    );
    await post(`/wardrobe/plans/${planId}/items`, {
      category: 'hats',
      quantity: '1',
      priority: 'medium',
    });
    let html = await page(`/wardrobe/plans/${planId}`);
    const itemId = Number(/id="plan-item-(\d+)"/.exec(html)![1]);

    const products: number[] = [];
    for (const name of ['Loafers', 'Brogues']) {
      const product = await createWishlistItem(t, { name, category: 'hats' });
      await uploadPhoto(t, product, await jpegPhoto());
      products.push(product);
    }
    const withoutPhoto = await createWishlistItem(t, {
      name: 'Clogs',
      category: 'hats',
    });
    await changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [itemId], garmentIds: [...products, withoutPhoto] },
    });

    html = await page(`/wardrobe/plans/${planId}`);
    const card = html.slice(
      html.indexOf(`id="plan-item-${itemId}"`),
      html.indexOf('</li>', html.indexOf(`id="plan-item-${itemId}"`)),
    );
    const set = setOf(card, `plan-item-${itemId}-photos`);
    // Candidates with a photo only; the lead is one of them.
    expect(set).toHaveLength(2);
    const large = triggers(card, `plan-item-${itemId}-photos`);
    // The card's enlarge button, and the sheet's photo.
    expect(large).toHaveLength(2);
    for (const src of large) expect(set).toContain(src);

    // Every trigger on the page opens a photo of its own set, whichever card.
    const ids = new Set(
      [...html.matchAll(/data-photo-open="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) {
      const own = setOf(html, id);
      for (const src of triggers(html, id)) expect(own).toContain(src);
    }
  });
});
