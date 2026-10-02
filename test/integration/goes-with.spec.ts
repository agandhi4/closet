import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outfit, planItem } from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { callTool, createAccessToken, tool } from './mcp';
import { expectFragment, HX_FRAGMENT } from './pages';

/**
 * "Goes with my closet" (#18b): a wishlist item's page judges it against
 * the owner's whole closet through the generator, the item locked
 * (src/wardrobe/goes-with.ts, unit-tested on its own): the count and its
 * bound, the best few as display-only cards, the roles it pairs with, the
 * near-duplicates; the same through the MCP tool goes_with_closet and as a
 * count on the shopping list's candidate cards. And the other side of the
 * rule: the item never reaches ordinary ideas, `?with=` or a pick. The
 * grantee rows are in authorization-wardrobe.spec.ts.
 */

type Fields = Record<string, string | string[]>;

/** Every card's garment ids in a page, for a card's data attribute. */
function cardsOf(html: string, attribute: string): number[][] {
  return [...html.matchAll(new RegExp(`${attribute}="([\\d,]+)"`, 'g'))].map(
    (m) => m[1].split(',').map(Number),
  );
}

/** The goes-with section alone (the rest of the page names garments too). */
function sectionOf(html: string): string {
  const start = html.indexOf('id="goes-with"');
  expect(start, 'the goes-with section').toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

describe('goes with my closet', () => {
  let t: TestApp;
  let token: string;
  const closet: Record<string, number> = {};
  let archivedJeans: number;
  /** Red and green, formality 3: pairs with some of the closet, not all. */
  let sweater: number;
  /** The same kind and colour as the white tee. */
  let secondTee: number;
  /** Replaces the white sneakers, like for like. */
  let newSneakers: number;
  let otherUser: string;
  let othersItem: number;

  const post = (url: string, payload: Fields, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });
  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  const idOf = (location: unknown) =>
    Number(/^\/wardrobe\/(\d+)/.exec(String(location))![1]);

  const garmentIn = async (
    name: string,
    fields: Fields,
    cookie?: string,
  ): Promise<number> => {
    const res = await post(
      '/wardrobe',
      { name, props: '1', pattern: 'solid', ...fields },
      cookie,
    );
    expect(res.statusCode, res.body).toBe(302);
    return idOf(res.headers.location);
  };

  const wishlistIn = async (
    name: string,
    fields: Fields,
    cookie?: string,
  ): Promise<number> =>
    garmentIn(
      name,
      { to: 'wishlist', wishlist: '1', replaces: '', product: '1', ...fields },
      cookie,
    );

  beforeAll(async () => {
    t = await createTestApp();
    const add = async (name: string, fields: Fields) => {
      closet[name] = await garmentIn(name, fields);
    };
    await add('White tee', {
      category: 'tops',
      type: 't-shirt',
      color: ['white'],
      formality: '2',
    });
    await add('Raw jeans', {
      category: 'bottoms',
      type: 'jeans',
      color: ['blue'],
      formality: '2',
    });
    await add('Khaki chinos', {
      category: 'bottoms',
      type: 'chinos',
      color: ['beige'],
      formality: '3',
    });
    await add('Grey trousers', {
      category: 'bottoms',
      type: 'trousers',
      color: ['grey'],
      formality: '3',
    });
    await add('Yellow shorts', {
      category: 'bottoms',
      type: 'shorts',
      color: ['yellow'],
      formality: '1',
    });
    await add('White sneakers', {
      category: 'footwear',
      type: 'sneakers',
      color: ['white'],
      formality: '2',
    });
    await add('Brown loafers', {
      category: 'footwear',
      type: 'loafers',
      color: ['brown'],
      formality: '3',
    });
    await add('Navy blazer', {
      category: 'outerwear',
      type: 'blazer',
      color: ['blue'],
      formality: '3',
    });
    await add('Green parka', {
      category: 'outerwear',
      type: 'parka',
      color: ['green'],
      formality: '2',
    });
    // Lent out: not available today, still the owner's to wear it with.
    const lent = await post(`/wardrobe/${closet['Brown loafers']}/away`, {
      away: 'lent',
      awayNote: 'Dana',
    });
    expect(lent.statusCode).toBe(303);
    archivedJeans = await garmentIn('Old jeans', {
      category: 'bottoms',
      type: 'jeans',
      color: ['black'],
    });
    const archived = await post(`/wardrobe/${archivedJeans}/archive`, {});
    expect(archived.statusCode).toBeLessThan(400);

    sweater = await wishlistIn('Christmas sweater', {
      category: 'tops',
      type: 'sweater',
      color: ['red', 'green'],
      formality: '3',
    });
    secondTee = await wishlistIn('Another white tee', {
      category: 'tops',
      type: 't-shirt',
      color: ['white'],
      formality: '2',
    });
    newSneakers = await wishlistIn('New white sneakers', {
      category: 'footwear',
      type: 'sneakers',
      color: ['white'],
      formality: '2',
      replaces: String(closet['White sneakers']),
    });

    // Another person: 10 bottoms x 6 shoes, past the count's bound.
    otherUser = await t.register('other-goes-with@example.com');
    for (let i = 0; i < 10; i += 1) {
      await garmentIn(
        `Grey trousers ${i}`,
        { category: 'bottoms', color: ['grey'] },
        otherUser,
      );
    }
    for (let i = 0; i < 6; i += 1) {
      await garmentIn(
        `Black shoes ${i}`,
        { category: 'footwear', color: ['black'] },
        otherUser,
      );
    }
    othersItem = await wishlistIn(
      'Black tee',
      { category: 'tops', color: ['black'] },
      otherUser,
    );
    token = await createAccessToken(t);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('the wishlist item’s page', () => {
    it('counts the outfits it makes with the whole closet, and shows the best few', async () => {
      const res = await get(`/wardrobe/${sweater}`);
      expect(res.statusCode).toBe(200);
      const section = sectionOf(unescapeHtml(res.body));
      // 3 bottoms (the yellow shorts are a third colour) x 2 shoes, the
      // lent loafers included: a purchase is judged against what is owned.
      expect(section).toContain('Makes 6 outfits with your closet');
      expect(section).toContain('not the weather');
      const cards = cardsOf(section, 'data-goes-with-idea');
      expect(cards).toHaveLength(3);
      const drawable = new Set([
        sweater,
        closet['Raw jeans'],
        closet['Khaki chinos'],
        closet['Grey trousers'],
        closet['White sneakers'],
        closet['Brown loafers'],
      ]);
      for (const card of cards) {
        expect(card[0]).toBe(sweater);
        for (const id of card)
          expect(drawable.has(id), `garment ${id}`).toBe(true);
      }
      // At its formality (3) first: dressy trousers and the loafers.
      expect(cards[0]).toContain(closet['Brown loafers']);
      expect([closet['Khaki chinos'], closet['Grey trousers']]).toContain(
        cards[0][1],
      );
    });

    it('is display only: nothing posts, and it says why', async () => {
      const section = sectionOf((await get(`/wardrobe/${sweater}`)).body);
      expect(section).not.toContain('<form');
      expect(section).not.toContain('/outfits/ideas/pick');
      expect(section).toContain('once you have bought it');
      expect(section).toContain('snap-x snap-mandatory');
    });

    it('names the roles it pairs with, the layers judged one by one', async () => {
      const section = unescapeHtml(
        sectionOf((await get(`/wardrobe/${sweater}`)).body),
      );
      const row = (role: string) =>
        new RegExp(`data-goes-with-role="${role}"[^]*?</li>`).exec(
          section,
        )?.[0] ?? '';
      expect(row('bottom')).toContain('3 of 4');
      expect(row('bottom')).not.toContain('Yellow shorts');
      expect(row('bottom')).toContain(
        `href="/wardrobe/${closet['Khaki chinos']}"`,
      );
      expect(row('footwear')).toContain('2 of 2');
      // The navy blazer would be a third colour; the green parka is not.
      expect(row('layer')).toContain('1 of 2');
      expect(row('layer')).toContain('Green parka');
      expect(row('layer')).not.toContain('Navy blazer');
      expect(section).not.toContain('data-goes-with-role="top"');
    });

    it('warns of a near-identical garment already owned', async () => {
      const section = unescapeHtml(
        sectionOf((await get(`/wardrobe/${secondTee}`)).body),
      );
      expect(section).toContain('data-goes-with-duplicates');
      expect(section).toContain('Near-identical in your closet:');
      expect(section).toContain(`href="/wardrobe/${closet['White tee']}"`);
      // The sweater has no twin.
      const sweaterSection = sectionOf(
        (await get(`/wardrobe/${sweater}`)).body,
      );
      expect(sweaterSection).not.toContain('data-goes-with-duplicates');
      expect(sweaterSection).not.toContain('data-goes-with-replaces');
    });

    it('calls the one it replaces like for like, not a second one', async () => {
      const section = unescapeHtml(
        sectionOf((await get(`/wardrobe/${newSneakers}`)).body),
      );
      expect(section).toContain('data-goes-with-replaces');
      expect(section).toContain('Like for like: it replaces');
      expect(section).toContain(`href="/wardrobe/${closet['White sneakers']}"`);
      expect(section).not.toContain('data-goes-with-duplicates');
    });

    it('stops counting at its bound', async () => {
      const res = await get(`/wardrobe/${othersItem}`, otherUser);
      expect(sectionOf(res.body)).toContain(
        'Makes 50+ outfits with your closet',
      );
    });

    it('never judges anything but a wishlist item', async () => {
      for (const id of [closet['White tee'], archivedJeans]) {
        const res = await get(`/wardrobe/${id}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('id="goes-with"');
      }
    });

    it('draws uniformly: never reads a wear, and a wear changes nothing (#167)', async () => {
      const page = async () =>
        sectionOf((await get(`/wardrobe/${sweater}`)).body);
      const before = await page();
      const read = await recordQueries(page);
      expect(read.sql.filter((q) => q.includes('garment_wear'))).toEqual([]);
      // The rotation's input, had it been read, would now differ.
      const wore = await post(`/wardrobe/${closet['White tee']}/wear`, {
        worn: '1',
      });
      expect(wore.statusCode).toBeLessThan(400);
      expect(await page()).toBe(before);
      // Undone, so the tee is clean for the Ideas tab below.
      await post(`/wardrobe/${closet['White tee']}/wear`, { worn: '0' });
    });

    it('logs what it judged at debug', async () => {
      await get(`/wardrobe/${sweater}`);
      expect(t.logs.messages('debug', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Goes with my closet for user \\d+: wishlist item ${sweater} makes 6 outfit\\(s\\), 0 near-duplicate\\(s\\), in \\d+ ms$`,
          ),
        ),
      );
    });
  });

  describe('the wishlist item stays out of everything else', () => {
    it('is never in the Ideas tab, on any page', async () => {
      const seen = new Set<number>();
      let next: string | undefined = '/outfits/ideas';
      for (let pages = 0; next && pages < 20; pages += 1) {
        const res = await t.inject({
          method: 'GET',
          url: next,
          headers: pages === 0 ? {} : HX_FRAGMENT,
        });
        expect(res.statusCode).toBe(200);
        for (const card of cardsOf(res.body, 'data-idea')) {
          for (const id of card) seen.add(id);
        }
        next = /hx-get="(\/outfits\/ideas\/more\?[^"]+)"/.exec(
          unescapeHtml(res.body),
        )?.[1];
      }
      expect(seen.size).toBeGreaterThan(0);
      for (const id of [sweater, secondTee, newSneakers]) {
        expect(seen.has(id), `wishlist item ${id}`).toBe(false);
      }
    });

    it('cannot be styled or picked', async () => {
      expect((await get(`/outfits/ideas?with=${sweater}`)).statusCode).toBe(
        404,
      );
      const outfits = async () =>
        (await t.db.select({ n: count() }).from(outfit))[0].n;
      const before = await outfits();
      const res = await post('/outfits/ideas/pick', {
        garmentId: [
          String(sweater),
          String(closet['Khaki chinos']),
          String(closet['Brown loafers']),
        ],
      });
      // Refused whole and named: it is theirs, just not bought (#219).
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain(
        'Not saved: Christmas sweater is on your wishlist, not bought yet.',
      );
      expect(await outfits()).toBe(before);
    });

    it('is never in suggest_outfits, and pick_outfit refuses it', async () => {
      const answer = await tool<{ ideas: { garmentIds: number[] }[] }>(
        t,
        token,
        'suggest_outfits',
        { limit: 12 },
      );
      expect(answer.ideas.length).toBeGreaterThan(0);
      for (const idea of answer.ideas) {
        expect(idea.garmentIds).not.toContain(sweater);
      }
      const picked = await callTool(t, token, 'pick_outfit', {
        garmentIds: [sweater, closet['Raw jeans']],
      });
      expect(picked.isError).toBe(true);
    });
  });

  describe('goes_with_closet (MCP)', () => {
    interface Answer {
      item: { id: number; name: string };
      outfits: { count: number; capped: boolean; cap: number };
      best: { garments: { id: number }[]; atItemsFormality: boolean }[];
      pairsWith: {
        role: string;
        goWithIt: number;
        inCloset: number;
        best: { id: number; name: string; outfits: number | null }[];
      }[];
      nearDuplicates: { id: number; replacesIt: boolean }[];
      note: string;
    }

    it('answers what the page shows', async () => {
      const answer = await tool<Answer>(t, token, 'goes_with_closet', {
        garmentId: sweater,
      });
      expect(answer.item).toMatchObject({
        id: sweater,
        name: 'Christmas sweater',
      });
      expect(answer.outfits).toEqual({ count: 6, capped: false, cap: 50 });
      expect(answer.best).toHaveLength(3);
      expect(answer.best[0].atItemsFormality).toBe(true);
      for (const idea of answer.best) {
        expect(idea.garments.map((g) => g.id)).toContain(sweater);
      }
      expect(
        answer.pairsWith.map((r) => [r.role, r.goWithIt, r.inCloset]),
      ).toEqual([
        ['layer', 1, 2],
        ['bottom', 3, 4],
        ['footwear', 2, 2],
      ]);
      const layer = answer.pairsWith[0].best[0];
      expect(layer).toMatchObject({
        id: closet['Green parka'],
        outfits: null,
      });
      expect(answer.nearDuplicates).toEqual([]);
      expect(answer.note).toContain('Display only');
    });

    it('names near-duplicates, and the one it replaces', async () => {
      const tee = await tool<Answer>(t, token, 'goes_with_closet', {
        garmentId: secondTee,
      });
      expect(tee.nearDuplicates).toEqual([
        expect.objectContaining({ id: closet['White tee'], replacesIt: false }),
      ]);
      const sneakers = await tool<Answer>(t, token, 'goes_with_closet', {
        garmentId: newSneakers,
      });
      expect(sneakers.nearDuplicates).toEqual([
        expect.objectContaining({
          id: closet['White sneakers'],
          replacesIt: true,
        }),
      ]);
    });

    it('refuses anything but the caller’s own wishlist item', async () => {
      for (const garmentId of [closet['White tee'], othersItem, 999_999]) {
        const answer = await callTool(t, token, 'goes_with_closet', {
          garmentId,
        });
        expect(answer.isError, `garment ${garmentId}`).toBe(true);
        expect(answer.value.error).toBe('Not on your wishlist');
      }
    });
  });

  describe('the shopping list', () => {
    it('shows each candidate’s count, linking to its answer', async () => {
      const plan = await post('/wardrobe/plans', { name: 'Winter', notes: '' });
      expect(plan.statusCode).toBe(303);
      const planId = Number(
        /^\/wardrobe\/plans\/(\d+)/.exec(String(plan.headers.location))![1],
      );
      const item = await post(`/wardrobe/plans/${planId}/items`, {
        category: 'tops',
        colors: ['red'],
        quantity: '1',
        priority: 'medium',
      });
      expect(item.statusCode).toBe(303);
      const [{ id: itemId }] = await t.db
        .select({ id: planItem.id })
        .from(planItem)
        .where(eq(planItem.planId, planId));
      await changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [itemId], garmentIds: [sweater] },
      });
      // The list renders no count itself: each chip loads as it scrolls
      // into view, so the page's cost is the list's whatever its length.
      const res = await get(`/wardrobe/shopping?plan=${planId}`);
      expect(res.statusCode).toBe(200);
      const row = new RegExp(`id="candidate-${sweater}"[^]*?</li>`).exec(
        unescapeHtml(res.body),
      )![0];
      expect(row).not.toContain('Goes with');
      expect(row).toContain(`hx-get="/wardrobe/${sweater}/outfit-count"`);
      expect(row).toContain('hx-trigger="intersect once"');
      const chip = await t.inject({
        method: 'GET',
        url: `/wardrobe/${sweater}/outfit-count`,
        headers: HX_FRAGMENT,
      });
      expect(chip.statusCode).toBe(200);
      expectFragment(chip);
      expect(chip.body).toContain('Goes with 6 outfits');
      expect(unescapeHtml(chip.body)).toContain(
        `href="/wardrobe/${sweater}#goes-with"`,
      );
    });

    it('answers a count only for the owner’s own wishlist item', async () => {
      const count = (id: number, cookie?: string) =>
        get(`/wardrobe/${id}/outfit-count`, cookie);
      expect((await count(closet['White tee'])).statusCode).toBe(404);
      expect((await count(othersItem)).statusCode).toBe(404);
      expect((await count(999_999)).statusCode).toBe(404);
      expect((await count(othersItem, otherUser)).body).toContain(
        'Goes with 50+ outfits',
      );
    });
  });
});
