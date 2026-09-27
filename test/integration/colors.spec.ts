import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { createTestApp, TestApp } from './harness';

/**
 * garment.colors is a text[] set of GARMENT_COLORS names (#28), stored in
 * the list's order, null for none, like materials and plan_item.colors; the
 * form posts one `color` per checked box (the field's name since before the
 * array, so cached forms post what they always did), and the grid filters
 * with @>. Only built-in colours are stored, by the form and by
 * garment_colors_check: a posted value was once rendered by the colour
 * picker's script as markup, a stored XSS (audit2-correctness H5).
 */
describe('garment colours', () => {
  let t: TestApp;
  let garmentId: number;

  const listedNames = async (query: string) => {
    const res = await t.inject({ method: 'GET', url: `/wardrobe${query}` });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  const storedColors = async (id: number) =>
    (
      await t.db.query.garment.findFirst({
        columns: { colors: true },
        where: eq(garment.id, id),
      })
    )?.colors;

  const post = (url: string, payload: Record<string, unknown>) =>
    t.inject({ method: 'POST', url, payload });

  const created = async (payload: Record<string, unknown>) => {
    const res = await post('/wardrobe', payload);
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(res.headers.location as string)![1],
    );
  };

  beforeAll(async () => {
    t = await createTestApp();
    // Out of the list's order and repeated, as a client other than the
    // form's checkboxes may post them.
    garmentId = await created({
      name: 'Two-tone scarf',
      category: 'accessories',
      color: ['blue', 'red', 'blue'],
    });
    // One colour arrives as a scalar (a single checked box).
    await created({
      name: 'Plain green tee',
      category: 'tops',
      color: 'green',
    });
    await created({ name: 'Colourless belt', category: 'accessories' });
  });

  afterAll(() => t?.cleanup());

  it('stores the selection as a set in the list’s order', async () => {
    expect(await storedColors(garmentId)).toEqual(['red', 'blue']);
  });

  it('stores none as null, never an empty array', async () => {
    const id = await created({ name: 'Undyed', category: 'tops', color: [] });
    expect(await storedColors(id)).toBeNull();

    const edited = await post(`/wardrobe/${id}`, {
      name: 'Undyed',
      category: 'tops',
      color: 'white',
    });
    expect(edited.statusCode).toBe(302);
    expect(await storedColors(id)).toEqual(['white']);
    // An edit with every box unchecked posts no `color` and clears them.
    await post(`/wardrobe/${id}`, { name: 'Undyed', category: 'tops' });
    expect(await storedColors(id)).toBeNull();
  });

  it('shows both colours on the garment page and checks both on its form', async () => {
    const page = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('red, blue');

    const form = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}/edit`,
    });
    expect(form.body).toMatch(/name="color" value="red"\s+checked/);
    expect(form.body).toMatch(/name="color" value="blue"\s+checked/);
    expect(form.body).not.toMatch(/name="color" value="green"\s+checked/);
  });

  it('rejects a colour filter that is not a built-in name', async () => {
    for (const value of ['%', '%25', 'red%', 'crimson', 'red,blue', 'Red']) {
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe?color=${encodeURIComponent(value)}`,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('is found by either colour and not by another', async () => {
    const red = await listedNames('?color=red');
    expect(red).toContain('Two-tone scarf');
    expect(red).not.toContain('Colourless belt');
    expect(await listedNames('?color=blue')).toContain('Two-tone scarf');
    const green = await listedNames('?color=green');
    expect(green).toContain('Plain green tee');
    expect(green).not.toContain('Two-tone scarf');
    expect(green).not.toContain('Colourless belt');
    // No filter: every garment, coloured or not.
    expect(await listedNames('')).toContain('Colourless belt');
  });

  it('is enforced by the database: built-in names only, and never empty', async () => {
    const violation = {
      cause: { code: '23514', constraint: 'garment_colors_check' },
    };
    for (const colors of [sql`array['red', 'teal']`, sql`'{}'::text[]`]) {
      // Drizzle wraps the driver's error; the violation is its cause.
      await expect(
        t.db.execute(
          sql`update garment set colors = ${colors} where id = ${garmentId}`,
        ),
      ).rejects.toMatchObject(violation);
    }
    expect(await storedColors(garmentId)).toEqual(['red', 'blue']);
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
        expect(await storedColors(garmentId)).toEqual(['red', 'blue']);
      },
    );
  });
});
