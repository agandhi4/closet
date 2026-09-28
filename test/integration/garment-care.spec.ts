import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, garmentRepair } from '../../src/db/schema';
import { addDays } from '../../src/web/calendar/calendar-date';
import { createGarment, createWishlistItem } from './garments';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { createAccessToken, tool } from './mcp';
import {
  expectFragment,
  expectNativePostForms,
  expectNoRawI18nKeys,
} from './pages';

/**
 * The care label and the repair log (#23; plan section 17). The label is a
 * garment property: the form saves it beside its own marker, the role
 * decides whether it applies, the materials preset it, the page shows it,
 * the grid filters by its wash and the MCP tools read and write it. The
 * log is the owner's own record: logged and removed on the edit page, shown
 * on the garment page to the owner only, never to a grantee.
 */

/** A current garment form's post: properties and the care label. */
const SHIRT = {
  name: 'Oxford shirt',
  category: 'tops',
  props: '1',
  type: 'shirt',
  materials: ['cotton'],
  careLabel: '1',
  careWash: 'cold',
  careBleach: 'do_not_bleach',
  careDry: 'line',
  careIron: 'medium',
  careDryClean: 'allowed',
};

describe('the care label and the repair log', () => {
  let t: TestApp;

  const post = (url: string, payload: Record<string, unknown>) =>
    t.inject({ method: 'POST', url, payload });

  const row = async (id: number) =>
    (await t.db.select().from(garment).where(eq(garment.id, id)))[0];

  const create = async (payload: Record<string, unknown>) => {
    const res = await post('/wardrobe', payload);
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const repairs = (garmentId: number) =>
    t.db
      .select()
      .from(garmentRepair)
      .where(eq(garmentRepair.garmentId, garmentId));

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('the care label', () => {
    it('stores every instruction', async () => {
      expect(await row(await create(SHIRT))).toMatchObject({
        careWash: 'cold',
        careBleach: 'do_not_bleach',
        careDry: 'line',
        careIron: 'medium',
        careDryClean: 'allowed',
      });
    });

    it('leaves it alone when a form without its marker saves', async () => {
      const id = await create(SHIRT);
      // Cached before the label existed: properties, but no careLabel.
      const cached = Object.fromEntries(
        Object.entries(SHIRT).filter(([field]) => !field.startsWith('care')),
      );
      const res = await post(`/wardrobe/${id}`, { ...cached, name: 'Renamed' });
      expect(res.statusCode).toBe(302);
      expect(await row(id)).toMatchObject({
        name: 'Renamed',
        careWash: 'cold',
        careDryClean: 'allowed',
      });
    });

    it('clears what a current form sends empty, and all of it for shoes', async () => {
      const id = await create(SHIRT);
      await post(`/wardrobe/${id}`, { ...SHIRT, careWash: '', careIron: '' });
      expect(await row(id)).toMatchObject({
        careWash: null,
        careIron: null,
        careDry: 'line',
      });
      await post(`/wardrobe/${id}`, { ...SHIRT, category: 'footwear' });
      expect(await row(id)).toMatchObject({
        careWash: null,
        careBleach: null,
        careDry: null,
        careIron: null,
        careDryClean: null,
      });
    });

    it('refuses a value outside a set, in the form and in the database', async () => {
      const res = await post('/wardrobe', { ...SHIRT, careWash: 'boil' });
      expect(res.statusCode).toBe(400);
      const id = await createGarment(t, { name: 'Target', category: 'tops' });
      await expect(
        t.db.execute(
          sql`update garment set care_wash = 'boil' where id = ${id}`,
        ),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'garment_care_wash_check' },
      });
    });

    it('renders on the form with the materials its presets came from', async () => {
      const id = await create(SHIRT);
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}/edit`,
      });
      expect(res.statusCode).toBe(200);
      expectNoRawI18nKeys(res);
      expect(res.body).toContain('name="careLabel" value="1"');
      expect(res.body).toMatch(/name="careWash" value="cold"[^>]*checked/);
      expect(res.body).toMatch(/name="presetMaterials" value="cotton"/);
    });

    it('offers no label for shoes, and still posts its marker', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe/properties-fragment',
        payload: { category: 'footwear' },
        headers: { 'hx-request': 'true' },
      });
      expect(res.body).not.toContain('name="careWash"');
      expect(res.body).toContain('name="careLabel" value="1"');
    });

    it('shows the label and the care notes on the garment page', async () => {
      const id = await create({ ...SHIRT, washingDetails: 'Inside out' });
      const res = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
      expect(res.statusCode).toBe(200);
      expectNoRawI18nKeys(res);
      const html = unescapeHtml(res.body);
      for (const text of [
        'Care label',
        'Machine wash cold (30 °C)',
        'Do not bleach',
        'Line dry',
        'Iron warm',
        'Can be dry cleaned',
        'Inside out',
      ]) {
        expect(html).toContain(text);
      }
    });
  });

  describe('presets from the materials', () => {
    const fragment = (payload: Record<string, unknown>) =>
      t.inject({
        method: 'POST',
        url: '/wardrobe/properties-fragment',
        payload,
        headers: { 'hx-request': 'true' },
      });

    it('fills the label from a material', async () => {
      const res = await fragment({ category: 'tops', materials: ['wool'] });
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toMatch(/name="careWash" value="hand"[^>]*checked/);
      expect(res.body).toMatch(/name="careDry" value="flat"[^>]*checked/);
      expect(res.body).toMatch(/name="presetMaterials" value="wool"/);
      // Dry cleaning is never preset.
      expect(res.body).not.toMatch(
        /name="careDryClean" value="[^"]+"[^>]*checked/,
      );
    });

    it('moves what is still at the old materials’ presets and keeps a choice', async () => {
      const res = await fragment({
        category: 'tops',
        materials: ['silk'],
        // Cotton's presets, but the wash was chosen by hand.
        careWash: 'cold',
        careBleach: 'non_chlorine',
        careDry: 'tumble',
        careIron: 'high',
        presetMaterials: 'cotton',
      });
      expect(res.body).toMatch(/name="careWash" value="cold"[^>]*checked/);
      expect(res.body).toMatch(
        /name="careBleach" value="do_not_bleach"[^>]*checked/,
      );
      expect(res.body).toMatch(/name="careDry" value="flat"[^>]*checked/);
      expect(res.body).toMatch(/name="careIron" value="low"[^>]*checked/);
    });
  });

  describe('the wash filter', () => {
    it('finds garments by the label’s wash, offering only washes held', async () => {
      await create({ ...SHIRT, name: 'Hand wash knit', careWash: 'hand' });
      const all = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(all.body).toMatch(/name="wash" value="hand"/);
      expect(all.body).not.toMatch(/name="wash" value="hot"/);
      const hand = await t.inject({
        method: 'GET',
        url: '/wardrobe?wash=hand',
      });
      expect(hand.statusCode).toBe(200);
      expect(hand.body).toContain('Hand wash knit');
      expect(hand.body).not.toContain('Oxford shirt');
      const bad = await t.inject({ method: 'GET', url: '/wardrobe?wash=boil' });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('the repair log', () => {
    const log = (id: number, payload: Record<string, unknown>) =>
      post(`/wardrobe/${id}/repairs`, payload);

    it('logs an entry and shows it on the garment page with its total', async () => {
      const id = await create(SHIRT);
      const res = await log(id, {
        day: t.today(),
        kind: 'repair',
        note: '  New buttons  ',
        cost: '$8.5',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `/wardrobe/${id}?repairSaved=1#garment-repairs`,
      );
      await log(id, {
        day: addDays(t.today(), -30),
        kind: 'alteration',
        note: 'Sleeves shortened',
        cost: '20',
      });
      expect(await repairs(id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'repair',
            note: 'New buttons',
            cost: '8.50',
          }),
          expect.objectContaining({ kind: 'alteration', cost: '20.00' }),
        ]),
      );
      const page = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
      expectNoRawI18nKeys(page);
      const html = unescapeHtml(page.body);
      expect(html).toContain('Repairs and alterations');
      // Newest first.
      expect(html.indexOf('New buttons')).toBeLessThan(
        html.indexOf('Sleeves shortened'),
      );
      expect(html).toContain('Spent on it: $28.50');
      expect(html).toContain(`/wardrobe/${id}/edit#garment-repairs`);
    });

    it('lists the log with Remove on the owner’s edit page, and removes an entry', async () => {
      const id = await create(SHIRT);
      await log(id, { day: t.today(), kind: 'repair', note: 'Patched elbow' });
      const [entry] = await repairs(id);
      const edit = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}/edit`,
      });
      expect(edit.statusCode).toBe(200);
      expectNativePostForms(edit);
      expect(edit.body).toContain('id="garment-repairs"');
      expect(edit.body).toContain('Patched elbow');
      expect(edit.body).toContain(`/wardrobe/${id}/repairs/${entry.id}/delete`);
      // Today is the default and the latest day.
      expect(edit.body).toContain(`value="${t.today()}"`);
      expect(edit.body).toContain(`max="${t.today()}"`);
      const removed = await post(
        `/wardrobe/${id}/repairs/${entry.id}/delete`,
        {},
      );
      expect(removed.statusCode).toBe(303);
      expect(removed.headers.location).toBe(
        `/wardrobe/${id}/edit#garment-repairs`,
      );
      expect(await repairs(id)).toEqual([]);
      const again = await post(
        `/wardrobe/${id}/repairs/${entry.id}/delete`,
        {},
      );
      expect(again.statusCode).toBe(404);
    });

    it('re-renders the edit page with messages for what cannot be logged', async () => {
      const id = await create(SHIRT);
      const res = await log(id, {
        day: addDays(t.today(), 1),
        kind: 'repair',
        note: '   ',
        cost: 'lots',
      });
      expect(res.statusCode).toBe(400);
      expectNoRawI18nKeys(res);
      expect(res.body).toContain('Log it on the day it was done, not before');
      expect(res.body).toContain('Say what was done');
      expect(res.body).toContain('Enter a price such as 49.90');
      // The garment form is still there, as stored.
      expect(res.body).toContain('value="Oxford shirt"');
      expect(await repairs(id)).toEqual([]);
    });

    it('refuses a wishlist item: nothing is owned to mend yet', async () => {
      const wish = await createWishlistItem(t, { name: 'Maybe' });
      const res = await log(wish, {
        day: t.today(),
        kind: 'repair',
        note: 'Nope',
      });
      expect(res.statusCode).toBe(409);
      const edit = await t.inject({
        method: 'GET',
        url: `/wardrobe/${wish}/edit`,
      });
      expect(edit.body).not.toContain('id="garment-repairs"');
    });

    it('goes with the garment when it is deleted', async () => {
      const id = await create(SHIRT);
      await log(id, { day: t.today(), kind: 'repair', note: 'Darned' });
      const res = await t.inject({ method: 'DELETE', url: `/wardrobe/${id}` });
      expect(res.statusCode).toBe(200);
      expect(await repairs(id)).toEqual([]);
    });

    it('is never shown to a grantee, who sees the label', async () => {
      const id = await create(SHIRT);
      await log(id, { day: t.today(), kind: 'repair', note: 'Owner secret' });
      const cookie = await t.register('care-viewer@example.com');
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'MANAGE' },
        headers: { 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie },
      });
      const q = `?ownerId=${t.owner.id}`;
      const page = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}${q}`,
        headers: { cookie },
      });
      expect(page.statusCode).toBe(200);
      expect(unescapeHtml(page.body)).toContain('Machine wash cold (30 °C)');
      expect(page.body).not.toContain('Owner secret');
      expect(page.body).not.toContain('garment-repairs');
      const edit = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}/edit${q}`,
        headers: { cookie },
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.body).not.toContain('Owner secret');
      expect(edit.body).not.toContain('id="garment-repairs"');
    });
  });

  describe('MCP', () => {
    let token: string;

    beforeAll(async () => {
      token = await createAccessToken(t);
    });

    it('get_garment answers the label, and the log to the owner', async () => {
      const id = await create(SHIRT);
      await post(`/wardrobe/${id}/repairs`, {
        day: t.today(),
        kind: 'alteration',
        note: 'Tapered',
        cost: '15',
      });
      const answer = await tool<{
        careLabel: Record<string, unknown>;
        repairs: Record<string, unknown>[];
      }>(t, token, 'get_garment', { id });
      expect(answer.careLabel).toMatchObject({
        wash: 'cold',
        bleach: 'do_not_bleach',
        dry: 'line',
        iron: 'medium',
        dryClean: 'allowed',
      });
      expect(answer.repairs).toEqual([
        expect.objectContaining({
          day: t.today(),
          kind: 'alteration',
          note: 'Tapered',
          cost: '15.00',
        }),
      ]);
    });

    it('update_garment presets the label from new materials, explicit values winning', async () => {
      const id = await create({ ...SHIRT, careLabel: '1', careWash: '' });
      const updated = await tool<{
        garment: { careLabel: Record<string, unknown> };
      }>(t, token, 'update_garment', {
        id,
        materials: ['wool'],
        careIron: 'do_not_iron',
      });
      expect(updated.garment.careLabel).toMatchObject({
        // Unset: filled from wool.
        wash: 'hand',
        // Chosen before (not cotton's preset): kept.
        dry: 'line',
        iron: 'do_not_iron',
      });
    });

    it('search_garments filters by the wash', async () => {
      await create({ ...SHIRT, name: 'Hand wash knit', careWash: 'hand' });
      await create({ ...SHIRT, name: 'Cold wash tee' });
      const found = await tool<{ garments: { name: string }[] }>(
        t,
        token,
        'search_garments',
        { wash: 'hand' },
      );
      expect(found.garments.map((g) => g.name)).toContain('Hand wash knit');
      expect(found.garments.map((g) => g.name)).not.toContain('Cold wash tee');
    });
  });
});
