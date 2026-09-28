import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capsule, capsuleGarment, file, garment } from '../../src/db/schema';
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
    [...html.matchAll(/<a href="\/wardrobe\/(\d+)"[^>]*data-tile=""/g)].map(
      (m) => Number(m[1]),
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

  // Production pays a network round trip per statement (#156), so these
  // counts are the page's latency budget (#159): the session, the page,
  // and one statement for everything around it (gridContext).
  describe('statements per request', () => {
    it('the page: the tiles, and the count, filter values, capsules, prompts and switcher together', async () => {
      const record = await recordQueries(() => get('/wardrobe'));
      expect(record.statements).toBe(3);
      // A page of tiles (and the one that says there are more), and one row
      // for everything else: the lists arrive as JSON inside it.
      expect(record.rows).toBe(1 + (GRID_PAGE_SIZE + 1) + 1);
      const context = record.sql.find((sql) => sql.includes('json_agg'));
      for (const read of ['pending_photo', 'wardrobe_share', 'capsule']) {
        expect(context).toContain(`"${read}"`);
      }
    });

    it('a fragment: the same, without the app bar’s switcher it does not render', async () => {
      const record = await recordQueries(() =>
        get('/wardrobe?keyword=garment', HX_FRAGMENT),
      );
      expect(record.statements).toBe(3);
      expect(record.sql.join('\n')).not.toContain('"wardrobe_share"');
    });

    it('select mode: the tiles alone, since it renders no count, filters or prompts', async () => {
      const record = await recordQueries(() => get('/wardrobe?select=1'));
      expect(record.statements).toBe(2);
    });

    it('the next page: the tiles alone', async () => {
      const record = await recordQueries(() =>
        get(`/wardrobe/tiles?before=${ids[GRID_PAGE_SIZE - 1]}`, HX_FRAGMENT),
      );
      expect(record.statements).toBe(2);
    });

    it('the capsule picker: members marked on the tiles, the capsule looked up with the context', async () => {
      const [picked] = await t.db
        .insert(capsule)
        .values({ ownerId: t.owner.id, name: 'Picked' })
        .returning({ id: capsule.id });
      await t.db.insert(capsuleGarment).values(
        [ids[0], ids[2]].map((garmentId) => ({
          capsuleId: picked.id,
          garmentId,
        })),
      );

      const page = await recordQueries(() =>
        get(`/wardrobe?pick=${picked.id}`),
      );
      expect(page.statements).toBe(3);
      const { html } = await get(`/wardrobe?pick=${picked.id}`);
      const checked = [
        ...html.matchAll(
          /<input[^>]*name="ids"[^>]*value="(\d+)"[^>]*\schecked=""/g,
        ),
      ].map((m) => Number(m[1]));
      expect(checked).toEqual([ids[0], ids[2]]);

      const next = await recordQueries(() =>
        get(
          `/wardrobe/tiles?pick=${picked.id}&before=${ids[GRID_PAGE_SIZE - 1]}`,
          HX_FRAGMENT,
        ),
      );
      expect(next.statements).toBe(2);
    });
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
