import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import { createGarment, createWishlistItem } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * An outfit beside its name is its whole picture (#360;
 * docs/plans/2026-10-09-structural-refactors.md, U4): the pickers'
 * SavedOutfitButton (the calendar's plan page, a trip's add page) and a
 * trip's own outfit rows draw `OutfitCollage size="row"`, every piece top
 * to toe, the shoes included, where they once showed the first three or
 * four garments in saved order. A piece to buy keeps its mark.
 */
describe('outfit rows', () => {
  let t: TestApp;
  let whole: number;
  let incomplete: number;
  let tripId: number;

  const form = (fields: [string, string][]) => ({
    payload: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  const post = async (url: string, fields: [string, string][]) =>
    t.inject({ method: 'POST', url, ...form(fields) });

  const page = async (url: string) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode, res.body).toBe(200);
    return res.body;
  };

  const createOutfit = async (name: string, garments: [string, number][]) => {
    const res = await post('/outfits', [
      ['name', name],
      ...garments.flatMap(([category, id]): [string, string][] => [
        ['category', category],
        ['garmentId', String(id)],
      ]),
    ]);
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  /** A saved outfit's button on a picker. */
  const buttonOf = (html: string, outfitId: number) => {
    const match = new RegExp(
      `<button[^>]*value="${outfitId}"[^>]*>[\\s\\S]*?</button>`,
    ).exec(html);
    expect(match, `no button for outfit ${outfitId}`).not.toBeNull();
    return match![0];
  };

  /** The one element whose class has `token`, open tag to its matching close (spans only). */
  const elementWithClass = (html: string, token: string) => {
    const opens = [
      ...html.matchAll(new RegExp(`<span[^>]*class="[^"]*${token}[^"]*"`, 'g')),
    ];
    expect(opens, `one element with ${token}`).toHaveLength(1);
    const start = opens[0].index;
    const tags = /<span\b|<\/span>/g;
    tags.lastIndex = start;
    let depth = 0;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
      depth += tag[0] === '</span>' ? -1 : 1;
      if (depth === 0) return html.slice(start, tags.lastIndex);
    }
    throw new Error(`unclosed element with ${token}`);
  };

  const piecesIn = (html: string) =>
    [...html.matchAll(/data-collage-piece="([^"]+)"/g)].map((m) => m[1]);

  const marksIn = (html: string) =>
    [...html.matchAll(/data-mark="([^"]+)"/g)].map((m) => m[1]);

  /** Saved feet first, so a first-N slice or the saved order would show. */
  const TOP_TO_TOE = [
    'outerwear',
    'tops',
    'bottoms',
    'footwear',
    'accessories',
  ];

  beforeAll(async () => {
    t = await createTestApp();
    const ids = Object.fromEntries(
      await Promise.all(
        TOP_TO_TOE.map(
          async (category) =>
            [
              category,
              await createGarment(t, { name: category, category }),
            ] as const,
        ),
      ),
    );
    whole = await createOutfit(
      'Whole look',
      ['footwear', 'accessories', 'bottoms', 'tops', 'outerwear'].map(
        (category) => [category, ids[category]],
      ),
    );
    const boots = await createWishlistItem(t, {
      name: 'Boots to buy',
      category: 'footwear',
    });
    incomplete = await createOutfit('Waiting on boots', [
      ['footwear', boots],
      ['tops', ids.tops],
    ]);
    const today = t.today();
    const trip = await post('/trips', [
      ['name', 'Lisbon'],
      ['destination', ''],
      ['startsOn', addDays(today, 3)],
      ['endsOn', addDays(today, 6)],
      ['notes', ''],
    ]);
    expect(trip.statusCode, trip.body).toBe(303);
    tripId = Number(/^\/trips\/(\d+)/.exec(String(trip.headers.location))![1]);
  });

  afterAll(() => t?.cleanup());

  it("the plan page's saved outfit shows every piece, top to toe", async () => {
    const day = addDays(t.today(), 2);
    const html = await page(`/calendar/plan?for=day:${day}&occasion=all-day`);
    expect(piecesIn(buttonOf(html, whole))).toEqual(TOP_TO_TOE);
  });

  it("the plan page marks the incomplete outfit's piece to buy, on its dimmed picture", async () => {
    const day = addDays(t.today(), 2);
    const button = buttonOf(
      await page(`/calendar/plan?for=day:${day}&occasion=all-day`),
      incomplete,
    );
    expect(button).toMatch(/<button[^>]*disabled/);
    expect(piecesIn(button)).toEqual(['tops', 'footwear']);
    expect(marksIn(button)).toEqual(['to-buy']);
    const dimmed = elementWithClass(button, 'group-disabled:opacity-50');
    expect(dimmed).toMatch(/^<span[^>]*aria-hidden="true"/);
    expect(dimmed).toContain('data-collage-piece=');
    expect(dimmed).not.toContain('Waiting on boots');
    expect(button).toContain('Waiting on boots');
  });

  it("a trip's add page shows every piece, and the mark", async () => {
    const html = await page(`/trips/${tripId}/outfits/new`);
    expect(piecesIn(buttonOf(html, whole))).toEqual(TOP_TO_TOE);
    expect(marksIn(buttonOf(html, incomplete))).toEqual(['to-buy']);
  });

  it("a trip's outfit row shows every piece", async () => {
    const res = await post(`/trips/${tripId}/outfits`, [
      ['outfitId', String(whole)],
      ['day', ''],
      ['occasion', ''],
    ]);
    expect(res.statusCode, res.body).toBeLessThan(400);
    const row = /<article[^>]*data-trip-outfit=[\s\S]*?<\/article>/.exec(
      await page(`/trips/${tripId}`),
    );
    expect(row).not.toBeNull();
    expect(row![0]).toContain('Whole look');
    expect(piecesIn(row![0])).toEqual(TOP_TO_TOE);
  });
});
