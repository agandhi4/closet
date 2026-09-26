import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { createTestApp, TestApp } from './harness';

/**
 * garment.color is a comma-joined list of GARMENT_COLORS names
 * (src/web/wardrobe/garment.ts); the form posts one `color` per checked box,
 * the grid filters on whole items of the list. Only built-in colours are
 * stored: a posted value was once rendered by the colour picker's script as
 * markup, a stored XSS (audit2-correctness H5).
 */
describe('garment colours', () => {
  let t: TestApp;
  let garmentId: number;

  const listedNames = async (query: string) => {
    const res = await t.inject({ method: 'GET', url: `/wardrobe${query}` });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  const storedColor = async (id: number) =>
    (
      await t.db.query.garment.findFirst({
        columns: { color: true },
        where: eq(garment.id, id),
      })
    )?.color;

  const post = (url: string, payload: Record<string, unknown>) =>
    t.inject({ method: 'POST', url, payload });

  beforeAll(async () => {
    t = await createTestApp();
    const res = await post('/wardrobe', {
      name: 'Two-tone scarf',
      category: 'accessories',
      color: ['red', 'blue'],
    });
    expect(res.statusCode).toBe(302);
    garmentId = Number(
      /^\/wardrobe\/(\d+)\?/.exec(res.headers.location as string)![1],
    );
    const plain = await post('/wardrobe', {
      name: 'Plain green tee',
      category: 'tops',
      color: 'green',
    });
    expect(plain.statusCode).toBe(302);
  });

  afterAll(() => t?.cleanup());

  it('stores the selection as a comma-joined list', async () => {
    expect(await storedColor(garmentId)).toBe('red,blue');
  });

  it('shows both colours on the garment page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('red, blue');
  });

  it('rejects a colour filter that is not a built-in name, so LIKE wildcards never reach the query', async () => {
    for (const value of ['%', '%25', 'red%', 'crimson', 'red,blue']) {
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe?color=${encodeURIComponent(value)}`,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('is found by either colour and not by another', async () => {
    expect(await listedNames('?color=red')).toContain('Two-tone scarf');
    expect(await listedNames('?color=blue')).toContain('Two-tone scarf');
    const green = await listedNames('?color=green');
    expect(green).toContain('Plain green tee');
    expect(green).not.toContain('Two-tone scarf');
  });

  describe('a colour outside the built-in set', () => {
    const HOSTILE = '<img src=x onerror=alert(1)>';

    it.each([
      ['a new garment', () => '/wardrobe'],
      ['an edit', () => `/wardrobe/${garmentId}`],
      ['a clone', () => `/wardrobe/${garmentId}/clone`],
    ])(
      'is refused on %s: 400, the form again, the value named as text',
      async (_what, url) => {
        const before = await t.db.$count(garment);
        const res = await post(url(), {
          name: 'Hostile',
          category: 'tops',
          color: ['red', HOSTILE, 'Teal'],
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain('<form method="post"');
        // Named in the message, escaped; never an option or raw markup.
        expect(res.body).toContain(
          'Not a color this wardrobe knows: &lt;img src=x onerror=alert(1)&gt;',
        );
        expect(res.body).toContain('Not a color this wardrobe knows: Teal');
        expect(res.body).not.toContain(HOSTILE);
        expect(res.body).not.toMatch(/name="color" value="Teal"/);
        // The valid choice stays checked for the next try.
        expect(res.body).toMatch(/name="color" value="red"\s+checked/);
        expect(await t.db.$count(garment)).toBe(before);
        expect(await storedColor(garmentId)).toBe('red,blue');
      },
    );
  });
});
