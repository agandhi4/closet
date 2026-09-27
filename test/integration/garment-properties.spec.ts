import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { createGarment } from './garments';
import { createTestApp, type TestApp } from './harness';
import {
  expectFragment,
  expectNativePostForms,
  expectNoRawI18nKeys,
} from './pages';

/**
 * Garment properties (src/wardrobe/properties.ts; plan section 6, issue
 * #12): the form saves them, a save keeps only what the category's role
 * has, a form without them (cached before they existed) leaves them
 * alone, the database refuses values outside the sets, and the properties
 * fragment fills presets without overwriting a choice.
 */

/** The fields a current garment form posts, properties included. */
const TEE = {
  name: 'Heavyweight tee',
  category: 'tops',
  props: '1',
  type: 't-shirt',
  warmth: '3',
  formality: '2',
  materials: ['cotton'],
  pattern: 'solid',
  fit: 'relaxed',
  sleeve: 'short',
  fabricWeight: '6',
  fabricWeightUnit: 'oz',
};

describe('garment properties', () => {
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
    it('stores every property, the weight in gsm', async () => {
      const stored = await row(await create(TEE));
      expect(stored).toMatchObject({
        type: 't-shirt',
        warmth: 3,
        formality: 2,
        materials: ['cotton'],
        pattern: 'solid',
        fit: 'relaxed',
        sleeve: 'short',
        length: null,
        fabricWeight: 203,
        waterResistant: false,
      });
    });

    it('takes a weight in gsm too', async () => {
      const stored = await row(
        await create({ ...TEE, fabricWeight: '240', fabricWeightUnit: 'gsm' }),
      );
      expect(stored.fabricWeight).toBe(240);
    });

    it('drops what the role does not have, and a type from another category', async () => {
      const stored = await row(
        await create({
          ...TEE,
          category: 'footwear',
          type: 't-shirt',
          waterResistant: 'true',
        }),
      );
      expect(stored).toMatchObject({
        category: 'footwear',
        type: null,
        sleeve: null,
        fit: null,
        fabricWeight: null,
        // Footwear has warmth and water resistance, not a pattern.
        pattern: null,
        warmth: 3,
        waterResistant: true,
      });
    });

    it('stores materials as a set, and none as null', async () => {
      const twice = await row(
        await create({ ...TEE, materials: ['linen', 'cotton', 'linen'] }),
      );
      expect(twice.materials).toEqual(['cotton', 'linen']);
      const none = await row(await create({ ...TEE, materials: [] }));
      expect(none.materials).toBeNull();
    });

    it('gives a custom category the general properties and no type', async () => {
      const stored = await row(
        await create({ ...TEE, category: 'hats', type: 'beanie' }),
      );
      expect(stored).toMatchObject({
        category: 'hats',
        type: null,
        warmth: 3,
        formality: 2,
        sleeve: null,
      });
    });

    it('re-renders the form with a message for a weight that is not one', async () => {
      for (const fabricWeight of ['heavy', '0', '400']) {
        const res = await post('/wardrobe', { ...TEE, fabricWeight });
        expect(res.statusCode).toBe(400);
        expectNoRawI18nKeys(res);
        expect(res.body).toMatch(
          /Enter (the weight as a number|a weight between)/,
        );
        // The rest of what was posted is kept.
        expect(res.body).toContain('value="Heavyweight tee"');
      }
    });

    it('refuses a value outside a set with a 400 before anything is read', async () => {
      for (const bad of [
        { warmth: '9' },
        { pattern: 'paisley' },
        { materials: ['vinyl'] },
      ]) {
        const res = await post('/wardrobe', { ...TEE, ...bad });
        expect(res.statusCode).toBe(400);
      }
    });

    it('leaves stored properties alone when a form without them saves', async () => {
      const id = await create(TEE);
      // A form the installed app cached before properties existed: no
      // `props`, no property fields.
      const res = await post(`/wardrobe/${id}`, {
        name: 'Renamed tee',
        category: 'tops',
      });
      expect(res.statusCode).toBe(302);
      expect(await row(id)).toMatchObject({
        name: 'Renamed tee',
        type: 't-shirt',
        warmth: 3,
        fabricWeight: 203,
      });
    });

    it('clears properties a current form sends empty', async () => {
      const id = await create(TEE);
      await post(`/wardrobe/${id}`, {
        name: 'Plain',
        category: 'tops',
        props: '1',
      });
      expect(await row(id)).toMatchObject({
        type: null,
        warmth: null,
        materials: null,
        fabricWeight: null,
      });
    });
  });

  describe('the database', () => {
    it.each([
      ['warmth', sql`6`],
      ['formality', sql`0`],
      ['type', sql`'kimono'`],
      ['pattern', sql`'paisley'`],
      ['materials', sql`array['vinyl']`],
      ['materials', sql`array[]::text[]`],
      ['fabric_weight', sql`5`],
    ])('refuses %s = %s', async (column, value) => {
      const id = await createGarment(t, { name: 'Target', category: 'tops' });
      // Drizzle wraps the driver's error; the violation is its cause:
      // check_violation (23514) on the column's own constraint.
      await expect(
        t.db.execute(
          sql`update garment set ${sql.identifier(column)} = ${value} where id = ${id}`,
        ),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: `garment_${column}_check` },
      });
    });
  });

  describe('the form', () => {
    it('renders the stored properties, the weight in oz', async () => {
      const id = await create(TEE);
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}/edit`,
      });
      expect(res.statusCode).toBe(200);
      expectNoRawI18nKeys(res);
      expectNativePostForms(res);
      expect(res.body).toMatch(/name="type" value="t-shirt"[^>]*checked/);
      expect(res.body).toMatch(/name="warmth" value="3"[^>]*checked/);
      expect(res.body).toMatch(/name="materials" value="cotton"[^>]*checked/);
      expect(res.body).toMatch(/name="fabricWeight"[^>]*value="6"/);
      expect(res.body).toContain('name="props" value="1"');
      // Presets come from the stored type and weight.
      expect(res.body).toMatch(/name="presetType" value="t-shirt"/);
      expect(res.body).toMatch(/name="presetWeight" value="203"/);
    });

    it('offers no type or sleeve on a new form before a category', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe/new' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('name="type"');
      expect(res.body).not.toContain('name="sleeve"');
      expect(res.body).toContain('name="warmth"');
    });

    it('shows the properties on the garment page', async () => {
      const id = await create(TEE);
      const res = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
      expect(res.statusCode).toBe(200);
      expectNoRawI18nKeys(res);
      for (const text of [
        'T-shirt',
        'Medium',
        'Casual',
        '6 oz · 203 gsm',
        'Cotton',
        'Short sleeve',
      ]) {
        expect(res.body).toContain(text);
      }
    });
  });

  describe('POST /wardrobe/properties-fragment', () => {
    const fragment = (payload: Record<string, unknown>) =>
      t.inject({
        method: 'POST',
        url: '/wardrobe/properties-fragment',
        payload,
        headers: { 'hx-request': 'true' },
      });

    it('answers both blocks’ contents, the second out of band, never the blocks', async () => {
      const res = await fragment({ category: 'tops' });
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      // The blocks carry the triggers and their queue (src/web/autosave.tsx):
      // only their contents are replaced.
      expect(res.body).not.toContain('id="garment-props-main"');
      expect(res.body).not.toContain('hx-post');
      expect(res.body).toMatch(
        /id="garment-props-more" hx-swap-oob="innerHTML"/,
      );
      expect(res.body).toContain('name="warmth"');
      expect(res.body).toContain('name="sleeve"');
    });

    it('fills a chosen type’s presets', async () => {
      const res = await fragment({ category: 'tops', type: 't-shirt' });
      expect(res.body).toMatch(/name="warmth" value="2"[^>]*checked/);
      expect(res.body).toMatch(/name="sleeve" value="short"[^>]*checked/);
      expect(res.body).toMatch(/name="presetType" value="t-shirt"/);
    });

    it('warms the tee when the weight reaches 6 oz', async () => {
      const res = await fragment({
        category: 'tops',
        type: 't-shirt',
        warmth: '2',
        fabricWeight: '6',
        fabricWeightUnit: 'oz',
        presetCategory: 'tops',
        presetType: 't-shirt',
      });
      expect(res.body).toMatch(/name="warmth" value="3"[^>]*checked/);
      expect(res.body).toMatch(/name="presetWeight" value="203"/);
    });

    it('keeps a warmth the user chose', async () => {
      const res = await fragment({
        category: 'tops',
        type: 'sweater',
        warmth: '5',
        presetCategory: 'tops',
        presetType: 't-shirt',
      });
      expect(res.body).toMatch(/name="warmth" value="5"[^>]*checked/);
      expect(res.body).toMatch(/name="sleeve" value="long"[^>]*checked/);
    });

    it('drops a type the new category does not have', async () => {
      const res = await fragment({
        category: 'bottoms',
        type: 't-shirt',
        sleeve: 'short',
        presetCategory: 'tops',
        presetType: 't-shirt',
      });
      expect(res.body).toMatch(/name="type" value="jeans"/);
      expect(res.body).not.toMatch(/name="type" value="[^"]*"[^>]*checked/);
      expect(res.body).not.toContain('name="sleeve"');
    });

    it('needs a session', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe/properties-fragment',
        payload: { category: 'tops' },
        headers: { 'hx-request': 'true' },
        anonymous: true,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
