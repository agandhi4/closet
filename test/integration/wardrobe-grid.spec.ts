import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file, garment } from '../../src/db/schema';
import { GRID_PAGE_SIZE } from '../../src/web/wardrobe/queries';
import { HX_FRAGMENT } from './pages';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';

/**
 * The wardrobe grid in pages: GET /wardrobe renders the newest
 * GRID_PAGE_SIZE garments and a sentinel that, scrolled into view, fetches
 * GET /wardrobe/tiles?before=<last id> with the same filters (keyset
 * pagination: a page costs the same however deep it is). Filtering and
 * searching start again from the first page.
 */
describe('wardrobe grid', () => {
  let t: TestApp;
  /** Ids of the seeded garments, newest first. */
  let ids: number[];
  const TOTAL = GRID_PAGE_SIZE + 12;

  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await t.inject({ method: 'GET', url, headers });
    expect(res.statusCode).toBe(200);
    return { ...res, html: unescapeHtml(res.body) };
  };

  /** Garment ids of the tiles, in page order. */
  const tileIds = (html: string) =>
    [...html.matchAll(/<a href="\/wardrobe\/(\d+)" class="card/g)].map((m) =>
      Number(m[1]),
    );

  const sentinelUrl = (html: string) =>
    /hx-get="(\/wardrobe\/tiles\?[^"]+)"[^>]*hx-trigger="revealed"/.exec(
      html,
    )?.[1];

  beforeAll(async () => {
    t = await createTestApp();
    // Straight into the tables: the grid reads rows, and this many uploads
    // would only slow the spec. Every other garment has a photo row.
    const rows: (typeof garment.$inferInsert)[] = [];
    for (let i = 0; i < TOTAL; i++) {
      let photoId: number | null = null;
      if (i % 2 === 0) {
        const [photo] = await t.db
          .insert(file)
          .values({
            fileName: `${randomUUID()}.webp`,
            shareableId: randomUUID(),
            createdOn: new Date().toISOString(),
            createdById: t.owner.id,
          })
          .returning({ id: file.id });
        photoId = photo.id;
      }
      rows.push({
        shareableId: randomUUID(),
        ownerId: t.owner.id,
        name: i === 3 ? 'Sale 100% wool_coat' : `Garment ${i}`,
        category: i % 3 === 0 ? 'tops' : 'bottoms',
        photoId,
      });
    }
    const inserted = await t.db
      .insert(garment)
      .values(rows)
      .returning({ id: garment.id });
    ids = inserted.map((row) => row.id).reverse();
  });

  afterAll(() => t?.cleanup());

  it('renders the first page, newest first, the count of all, and a sentinel for the rest', async () => {
    const { html } = await get('/wardrobe');
    expect(tileIds(html)).toEqual(ids.slice(0, GRID_PAGE_SIZE));
    expect(html).toContain(`${TOTAL} results`);
    expect(sentinelUrl(html)).toBe(
      `/wardrobe/tiles?before=${ids[GRID_PAGE_SIZE - 1]}`,
    );
  });

  it('serves the next page as tiles alone, ending without a sentinel', async () => {
    const first = await get('/wardrobe');
    const next = await get(sentinelUrl(first.html)!, HX_FRAGMENT);
    expect(next.body).not.toContain('<main');
    expect(next.body).not.toContain('<html');
    expect(tileIds(next.html)).toEqual(ids.slice(GRID_PAGE_SIZE));
    expect(sentinelUrl(next.html)).toBeUndefined();
    // Later pages are below the fold: every image loads lazily.
    const images = next.html.match(/<img\b[^>]*>/g) ?? [];
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(img).toContain('loading="lazy"');
  });

  it('carries the filters into the sentinel, and pages within them', async () => {
    const tops = ids.filter((_, i) => (TOTAL - 1 - i) % 3 === 0);
    expect(tops.length).toBeLessThan(GRID_PAGE_SIZE);
    const { html } = await get('/wardrobe?category=Tops');
    expect(tileIds(html)).toEqual(tops);
    expect(html).toContain(`${tops.length} results`);
    expect(sentinelUrl(html)).toBeUndefined();

    const deep = await get(
      `/wardrobe/tiles?category=tops&before=${tops[5]}`,
      HX_FRAGMENT,
    );
    expect(tileIds(deep.html)).toEqual(tops.slice(6));
  });

  it('a filtered or searched fragment starts from the first page', async () => {
    const res = await get('/wardrobe?keyword=garment', HX_FRAGMENT);
    expect(res.headers.vary).toContain('HX-Request');
    expect(res.body.trimStart()).toMatch(/^<main id="wardrobe-main"/);
    expect(tileIds(res.html)).toEqual(
      ids.filter((id) => id !== ids[TOTAL - 1 - 3]).slice(0, GRID_PAGE_SIZE),
    );
    expect(sentinelUrl(res.html)).toBe(
      `/wardrobe/tiles?keyword=garment&before=${
        ids.filter((id) => id !== ids[TOTAL - 1 - 3])[GRID_PAGE_SIZE - 1]
      }`,
    );
  });

  it.each([
    // Wildcards in the keyword are matched as themselves.
    ['100%', 1],
    ['wool_coat', 1],
    ['%', 1],
    ['_', 1],
    ['\\', 0],
    // And case does not matter.
    ['SALE', 1],
  ])('keyword %j finds %i garment(s)', async (keyword, found) => {
    const { html } = await get(
      `/wardrobe?keyword=${encodeURIComponent(keyword)}`,
    );
    expect(tileIds(html)).toHaveLength(found);
  });

  it('reads the page as plain rows: one statement for the tiles, whatever the wardrobe holds', async () => {
    const record = await recordQueries(() => get('/wardrobe'));
    // Session, then page, count, filter values and shared wardrobes in
    // parallel. None of them returns more rows than a page and its lists.
    expect(record.statements).toBe(5);
    expect(record.rows).toBeLessThanOrEqual(1 + (GRID_PAGE_SIZE + 1) + 1 + 1);
  });

  it('a malformed cursor is a 400', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe/tiles?before=abc',
      headers: HX_FRAGMENT,
    });
    expect(res.statusCode).toBe(400);
  });
});
