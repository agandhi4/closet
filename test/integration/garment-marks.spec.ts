import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGarment, createWishlistItem } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * One status mark (#357): `garmentMarks()` (src/wardrobe/marks.ts) drawn by
 * `<GarmentMark>` (src/web/layout/garment-mark.tsx), so "Archived" and
 * "To buy" are the same badge, in the same words and variant, wherever a
 * garment shows its status. The grid lists owned garments only, so its
 * to-buy mark never shows; Styling shows a pick with Include picks on.
 */
describe('garment marks: one markup per mark', () => {
  let t: TestApp;
  let tee: number;
  let outfitId: number;
  let wanted: number;

  const page = async (url: string) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  /** Every rendering of `mark`'s badge on the page, whole. */
  const badges = (html: string, mark: string) =>
    html.match(
      new RegExp(`<span[^>]*data-mark="${mark}"[^>]*>.*?</span>`, 'g'),
    ) ?? [];

  beforeAll(async () => {
    t = await createTestApp();
    tee = await createGarment(t, { name: 'Old tee', category: 'tops' });
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: new URLSearchParams([
        ['name', 'Old favourite'],
        ['category', 'tops'],
        ['garmentId', String(tee)],
      ]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1],
    );
    const archived = await t.inject({
      method: 'POST',
      url: `/wardrobe/${tee}/archive`,
      headers: { 'hx-request': 'true' },
    });
    expect(archived.statusCode).toBe(200);
    wanted = await createWishlistItem(t, {
      name: 'Linen shirt',
      category: 'tops',
    });
  });

  afterAll(() => t?.cleanup());

  it('draws "Archived" the same on the grid, Styling and the garment page', async () => {
    const grid = badges(await page('/wardrobe?archived=true'), 'archived');
    const styling = badges(
      await page(`/styling?outfit=${outfitId}`),
      'archived',
    );
    const garment = badges(await page(`/wardrobe/${tee}`), 'archived');
    expect(grid).toHaveLength(1);
    expect(grid[0]).toContain('>Archived</span>');
    expect(grid[0]).toContain('badge-neutral');
    expect(styling).toEqual(grid);
    expect(garment).toEqual(grid);
  });

  it('draws "To buy" the same on Styling and the garment page', async () => {
    const styling = badges(await page('/styling?picks=1'), 'to-buy');
    const garment = badges(await page(`/wardrobe/${wanted}`), 'to-buy');
    expect(garment).toHaveLength(1);
    expect(garment[0]).toContain('>To buy</span>');
    expect(garment[0]).toContain('badge-accent');
    expect(styling).toEqual(garment);
  });
});
