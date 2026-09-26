import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { createGarment } from './garments';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { expectNativePostForms, expectNoRawI18nKeys } from './pages';

/**
 * The product link and price (garment.source_url, garment.price; #32, for
 * link import #6): the form saves and validates them, a form cached before
 * they existed (no `product=1`) leaves them alone, the database refuses
 * what the form would, and the garment page links out safely.
 */

const PRODUCT_URL =
  'https://www.uniqlo.com/us/en/products/E422992-000/00?colorDisplayCode=00';

/** What a current garment form posts, the product fields included. */
const TEE = {
  name: 'White tee',
  category: 'tops',
  props: '1',
  product: '1',
  sourceUrl: PRODUCT_URL,
  price: '24.90',
};

describe('garment product link and price', () => {
  let t: TestApp;

  const post = (url: string, payload: Record<string, unknown>) =>
    t.inject({ method: 'POST', url, payload });

  const row = async (id: number) =>
    (await t.db.select().from(garment).where(eq(garment.id, id)))[0];

  const create = async (payload: Record<string, unknown>) => {
    const res = await post('/wardrobe', payload);
    expect(res.statusCode).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('saving', () => {
    it('stores the link and the price with two decimals', async () => {
      const stored = await row(await create(TEE));
      expect(stored).toMatchObject({ sourceUrl: PRODUCT_URL, price: '24.90' });
    });

    it('reads prices as people type them', async () => {
      for (const [typed, price] of [
        ['49.9', '49.90'],
        ['$1,299', '1299.00'],
        [' 0 ', '0.00'],
        ['007.5', '7.50'],
      ]) {
        const stored = await row(await create({ ...TEE, price: typed }));
        expect(stored.price).toBe(price);
      }
    });

    it('stores blank fields as null', async () => {
      const stored = await row(
        await create({ ...TEE, sourceUrl: '  ', price: '' }),
      );
      expect(stored).toMatchObject({ sourceUrl: null, price: null });
    });

    it('re-renders the form with a message for a link that is not http(s)', async () => {
      for (const sourceUrl of [
        'javascript:alert(1)',
        'data:text/html,<b>hi</b>',
        'ftp://example.com/tee',
        'www.uniqlo.com/tee',
      ]) {
        const res = await post('/wardrobe', { ...TEE, sourceUrl });
        expect(res.statusCode).toBe(400);
        expectNoRawI18nKeys(res);
        expect(res.body).toContain('Enter a web address starting with');
        // "More details" opens to show it, and the rest is kept.
        expect(res.body).toMatch(/<details[^>]*open/);
        expect(res.body).toContain('value="White tee"');
      }
    });

    it('re-renders the form with a message for a price that is not one', async () => {
      for (const price of ['-5', 'free', '1.999', '123456789', '1e3']) {
        const res = await post('/wardrobe', { ...TEE, price });
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain('Enter a price such as 49.90');
      }
    });

    it('leaves the stored link and price alone when a form without them saves', async () => {
      const id = await create(TEE);
      // A form the installed app cached before the product fields: it posts
      // props=1 (it has the properties) but no `product` and neither field.
      const res = await post(`/wardrobe/${id}`, {
        name: 'Renamed tee',
        category: 'tops',
        props: '1',
      });
      expect(res.statusCode).toBe(302);
      expect(await row(id)).toMatchObject({
        name: 'Renamed tee',
        sourceUrl: PRODUCT_URL,
        price: '24.90',
      });
    });

    it('clears them when a current form sends them empty', async () => {
      const id = await create(TEE);
      await post(`/wardrobe/${id}`, {
        name: 'Plain',
        category: 'tops',
        product: '1',
        sourceUrl: '',
        price: '',
      });
      expect(await row(id)).toMatchObject({ sourceUrl: null, price: null });
    });

    it('carries them into a clone', async () => {
      const id = await create(TEE);
      const form = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}/clone`,
      });
      expect(unescapeHtml(form.body)).toContain(`value="${PRODUCT_URL}"`);
      expect(form.body).toContain('value="24.90"');
    });
  });

  describe('the database', () => {
    it.each([
      ['source_url', sql`'javascript:alert(1)'`],
      ['price', sql`-0.01`],
    ])('refuses %s = %s', async (column, value) => {
      const id = await createGarment(t, { name: 'Target', category: 'tops' });
      await expect(
        t.db.execute(
          sql`update garment set ${sql.identifier(column)} = ${value} where id = ${id}`,
        ),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: `garment_${column}_check` },
      });
    });
  });

  describe('the pages', () => {
    it('renders the stored values on the edit form, under the marker', async () => {
      const id = await create(TEE);
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}/edit`,
      });
      expect(res.statusCode).toBe(200);
      expectNativePostForms(res);
      expect(res.body).toContain('name="product" value="1"');
      expect(unescapeHtml(res.body)).toMatch(
        /name="sourceUrl"[^>]*value="https:\/\/www\.uniqlo\.com[^"]*"/,
      );
      expect(res.body).toMatch(/name="price"[^>]*value="24.90"/);
    });

    it('shows the price and a "View product" link that opens a new tab', async () => {
      const id = await create(TEE);
      const res = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
      expect(res.statusCode).toBe(200);
      expectNoRawI18nKeys(res);
      expect(res.body).toContain('$24.90');
      const link = /<a [^>]*>View product<\/a>/.exec(unescapeHtml(res.body));
      expect(link?.[0]).toContain(`href="${PRODUCT_URL}"`);
      expect(link?.[0]).toContain('target="_blank"');
      expect(link?.[0]).toContain('rel="noopener noreferrer"');
    });

    it('shows neither without them', async () => {
      const id = await create({ ...TEE, sourceUrl: '', price: '' });
      const res = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
      expect(res.body).not.toContain('View product');
      expect(res.body).not.toContain('>Price<');
    });
  });
});
