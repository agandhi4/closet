import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeCandidates } from '../../src/web/plans/candidates';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * The plan page's views (#312): Items (by type, a trimmed card with one
 * status line and its sheet) and Outfits (`?view=`, falling back to Items),
 * the header's one tally line, and the draft counts of the plans list.
 * The page's statement count: plan-look-reactions.spec.ts.
 */
describe('the plan page views', () => {
  let t: TestApp;
  let token: string;
  let seq = 0;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: object = {}) =>
    t.inject({ method: 'POST', url, payload });
  const page = async (url: string) => unescapeHtml((await get(url)).body);

  const addGarment = async (fields: Record<string, string>) => {
    const res = await post('/wardrobe', {
      name: `Piece ${++seq}`,
      props: '1',
      care: '1',
      ...fields,
    });
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const createPlan = async (name: string) => {
    const res = await post('/wardrobe/plans', { name, notes: '' });
    expect(res.statusCode, res.body).toBe(303);
    return Number(
      /^\/wardrobe\/plans\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const addItem = async (planId: number, fields: Record<string, string>) => {
    const res = await post(`/wardrobe/plans/${planId}/items`, {
      quantity: '1',
      priority: 'medium',
      ...fields,
    });
    expect(res.statusCode, res.body).toBe(303);
    const html = await page(`/wardrobe/plans/${planId}`);
    return Math.max(
      ...[...html.matchAll(/id="plan-item-(\d+)"/g)].map((m) => Number(m[1])),
    );
  };

  /** An item's card and its sheet, as the page draws them. */
  const cardOf = (html: string, itemId: number) => {
    const start = html.indexOf(`id="plan-item-${itemId}"`);
    const end = html.indexOf('</li>', start);
    return html.slice(start, end);
  };

  const statusLine = (card: string) =>
    /data-status-line="">([^<]*)</.exec(card)![1];

  beforeAll(async () => {
    t = await createTestApp();
    token = await createAccessToken(t, { name: 'Muse' });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('Items, by type', () => {
    let planId: number;
    let owned: number;
    let partly: number;
    let missing: number;

    beforeAll(async () => {
      planId = await createPlan('Capsule');
      await addGarment({ category: 'tops', color: 'white' });
      await addGarment({ category: 'tops', color: 'white' });
      owned = await addItem(planId, { category: 'bottoms' });
      await addGarment({ category: 'bottoms' });
      partly = await addItem(planId, { category: 'tops', quantity: '3' });
      missing = await addItem(planId, { category: 'shoes' });
      const loafers = await addGarment({
        name: 'Loafers',
        to: 'wishlist',
        wishlist: '1',
        replaces: '',
        product: '1',
        category: 'shoes',
        price: '90',
      });
      await changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [missing], garmentIds: [loafers] },
      });
    });

    it('groups the cards by role, top to toe, each under its count', async () => {
      const html = await page(`/wardrobe/plans/${planId}`);
      const roles = [
        ...html.matchAll(/<section[^>]*data-role="([a-z]+)"/g),
      ].map((m) => m[1]);
      expect(roles).toEqual(['top', 'bottom', 'none']);
      expect(html).toMatch(/Tops\s*<span[^>]*>· 1</);
      expect(html).toMatch(/Bottoms\s*<span[^>]*>· 1</);
    });

    it('says each item in one status line: owned, partly, missing with the top candidate’s price', async () => {
      const html = await page(`/wardrobe/plans/${planId}`);
      expect(cardOf(html, owned)).toContain('data-status="owned"');
      expect(statusLine(cardOf(html, owned))).toBe('Owned');
      expect(statusLine(cardOf(html, partly))).toMatch(/^\d of 3$/);
      expect(statusLine(cardOf(html, missing))).toBe('To buy · $90.00');
    });

    it('keeps what the card used to carry in its sheet, reached from the card', async () => {
      const html = await page(`/wardrobe/plans/${planId}`);
      const card = cardOf(html, missing);
      expect(card).toContain('showModal()');
      expect(card).toContain(`<dialog id="plan-sheet-${missing}"`);
      const sheet = card.slice(card.indexOf('<dialog'));
      expect(sheet).toContain(
        `/wardrobe/plans/${planId}/items/${missing}/edit`,
      );
      expect(sheet).toContain('data-candidates');
      expect(sheet).toContain('data-status-chip');
      expect(sheet).toContain(`/items/${missing}/change`);
      expect(cardOf(html, owned)).toContain('In your closet');
    });

    it('moves Shopping list and Compare into the plan’s menu, below no cards', async () => {
      const html = await page(`/wardrobe/plans/${planId}`);
      const menu = html.slice(html.indexOf('menu dropdown-content'));
      expect(menu.slice(0, menu.indexOf('</ul>'))).toContain('Shopping list');
      expect(html.indexOf('btn btn-outline flex-1')).toBe(-1);
    });
  });

  describe('?view=', () => {
    const checked = (html: string) =>
      /id="plan-view-(items|outfits)"[^>]*\bchecked\b/.exec(html)?.[1];

    it('holds both panels either way, and ?view= picks the checked tab; anything else is Items', async () => {
      const planId = await createPlan('Views');
      await addItem(planId, { category: 'tops' });
      const url = `/wardrobe/plans/${planId}`;
      const items = await page(url);
      const outfits = await page(`${url}?view=outfits`);
      const unknown = await page(`${url}?view=nonsense`);
      const long = await page(`${url}?view=${'x'.repeat(200)}`);
      for (const html of [items, outfits, unknown, long]) {
        expect(html).toContain('id="plan-role-');
        expect(html).toContain('id="plan-no-looks"');
        expect(html).toContain('id="plan-panel-items"');
        expect(html).toContain('id="plan-panel-outfits"');
      }
      expect(checked(items)).toBe('items');
      expect(checked(unknown)).toBe('items');
      expect(checked(long)).toBe('items');
      expect(checked(outfits)).toBe('outfits');
      // The switch is local: radios, no link and no script.
      expect(items).not.toContain(`href="${url}?view=outfits"`);
      expect(items).toContain('aria-label="Outfits 0"');
    });

    it('counts declined items in the Items tab', async () => {
      const planId = await createPlan('Declined count');
      await addItem(planId, { category: 'tops' });
      const proposed = await tool<{ id: number }>(
        t,
        token,
        'propose_plan_item',
        {
          planId,
          category: 'shoes',
        },
      );
      const before = await page(`/wardrobe/plans/${planId}`);
      expect(before).toContain('aria-label="Items 2"');
      const res = await post(
        `/wardrobe/plans/${planId}/items/${proposed.id}/decline`,
      );
      expect(res.statusCode, res.body).toBe(303);
      const after = await page(`/wardrobe/plans/${planId}`);
      expect(after).toContain('aria-label="Items 2"');
    });

    it('shows the price of the product on the card’s photo', async () => {
      const planId = await createPlan('Price');
      const item = await addItem(planId, { category: 'shoes' });
      const cheap = await addGarment({
        name: 'No photo',
        to: 'wishlist',
        wishlist: '1',
        replaces: '',
        product: '1',
        category: 'shoes',
        price: '40',
      });
      await changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [item], garmentIds: [cheap] },
      });
      const card = cardOf(await page(`/wardrobe/plans/${planId}`), item);
      // No candidate has a photo: the glyph, and the top candidate's price.
      expect(card).not.toContain('<img');
      expect(statusLine(card)).toBe('To buy · $40.00');
    });
  });

  describe('a draft with only proposals', () => {
    it('counts them on the list card and in the header, with no zero tally', async () => {
      const draft = await tool<{ id: number }>(t, token, 'create_plan', {
        name: 'Agent draft',
      });
      for (const category of ['tops', 'shoes']) {
        await tool(t, token, 'propose_plan_item', {
          planId: draft.id,
          category,
        });
      }
      const list = await page('/wardrobe/plans');
      expect(list).toContain('2 proposed · 0 looks');
      expect(list).not.toMatch(
        /Agent draft[\s\S]*?0 items · 0 looks · 0 to buy/,
      );
      const header = await page(`/wardrobe/plans/${draft.id}`);
      expect(header).not.toContain('0 owned');
      expect(header).toContain('2 proposed by your agent');
    });

    it('counts a draft holding only proposed looks as awaiting, not "0 items"', async () => {
      const draft = await tool<{ id: number }>(t, token, 'create_plan', {
        name: 'Look-only draft',
      });
      const tee = await addGarment({ category: 'tops', type: 't-shirt' });
      const shoe = await addGarment({ category: 'footwear', type: 'boots' });
      await tool(t, token, 'propose_look', {
        planId: draft.id,
        name: 'Proposed look',
        garmentIds: [tee, shoe],
      });
      const list = await page('/wardrobe/plans');
      const card = list.slice(list.indexOf('Look-only draft'));
      expect(card).toContain('1 proposed');
      expect(card.slice(0, 1500)).not.toContain('0 items · ');
    });
  });
});
