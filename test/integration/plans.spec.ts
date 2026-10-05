import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  planItem,
  styleProfile,
  user,
  wardrobePlan,
} from '../../src/db/schema';
import { lockOwner } from '../../src/web/auth/queries';
import { saveWeekTemplate } from '../../src/web/week-plan/template';
import {
  createPlan as insertPlan,
  insertItems,
} from '../../src/web/plans/queries';
import { PLAN_NAME_MAX } from '../../src/web/plans/validation';
import { findWeatherSettings, setHome } from '../../src/web/weather/queries';
import { recordStatements } from '../support/query-recorder';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import { acceptInvite, createInvite } from '../../src/web/sharing/queries';
import { createWishlistItem } from './garments';
import {
  createTestApp,
  hxLocationPath,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectFullPage } from './pages';

/**
 * Wardrobe plans and the style profile (#34, slice 34a; plan section 15),
 * through HTTP: the style profile form, plans (create, rename, one active,
 * duplicate, delete), plan items (the form's two layers), the gap view
 * (items grouped missing, partly, owned against the closet, with why),
 * proposals from the owner's agent (accept, dismiss), and "start from a
 * wardrobe" through a share. Both are private, like outfits: another user's
 * plan is a 404 and nobody else reads the profile. The matching rules
 * themselves are src/wardrobe/plans.spec.ts's; authorization-plans.spec.ts holds
 * the matrix rows.
 */
describe('wardrobe plans', () => {
  let t: TestApp;
  let ownerId: number;
  let stranger: string;

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: object, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });

  /** A closet garment through the garment form, with properties and care. */
  const addGarment = async (
    name: string,
    fields: Record<string, string | string[]>,
    cookie?: string,
  ): Promise<number> => {
    const res = await post(
      '/wardrobe',
      { name, props: '1', care: '1', ...fields },
      cookie,
    );
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const createPlan = async (name: string, cookie?: string) => {
    const res = await post('/wardrobe/plans', { name, notes: '' }, cookie);
    expect(res.statusCode, res.body).toBe(303);
    const match = /^\/wardrobe\/plans\/(\d+)\?created=1$/.exec(
      String(res.headers.location),
    );
    if (!match) throw new Error(`Unexpected redirect ${res.headers.location}`);
    return Number(match[1]);
  };

  const addItem = async (planId: number, fields: Record<string, unknown>) => {
    const res = await post(`/wardrobe/plans/${planId}/items`, {
      quantity: '1',
      priority: 'medium',
      ...fields,
    });
    expect(res.statusCode, res.body).toBe(303);
    expect(res.headers.location).toBe(`/wardrobe/plans/${planId}?saved=1`);
    const [row] = await t.db
      .select({ id: planItem.id })
      .from(planItem)
      .where(eq(planItem.planId, planId))
      .orderBy(asc(planItem.id))
      .then((rows) => rows.slice(-1));
    return row.id;
  };

  /** The status the gap view gives each item card (its data-status). */
  const statuses = (html: string) =>
    Object.fromEntries(
      [
        ...html.matchAll(
          /id="plan-item-(\d+)" data-status="(owned|partly|missing|proposed)"/g,
        ),
      ].map(([, id, status]) => [Number(id), status]),
    );

  const plansOf = (id: number) =>
    t.db
      .select({
        id: wardrobePlan.id,
        name: wardrobePlan.name,
        active: wardrobePlan.active,
      })
      .from(wardrobePlan)
      .where(eq(wardrobePlan.ownerId, id))
      .orderBy(asc(wardrobePlan.id));

  /**
   * Starts `requests` while a transaction holds `owner`'s lock, releases it
   * once `waiting` of them queue behind it, and answers them: requests
   * that read before they lock run those reads side by side, as two tabs.
   */
  const whileOwnerLocked = async <T>(
    owner: number,
    waiting: number,
    requests: () => Promise<T>[],
  ): Promise<T[]> => {
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = t.db.transaction(async (tx) => {
      await lockOwner(tx, owner);
      locked();
      await released;
    });
    await isLocked;
    const answers = Promise.all(requests());
    await expect
      .poll(async () => {
        const { rows } = await t.db.execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
        );
        return rows[0].waiting;
      })
      .toBe(waiting);
    release();
    await holder;
    return answers;
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    stranger = await t.register('stranger-plans@example.com');
  });

  afterAll(() => t?.cleanup());

  describe('the style profile', () => {
    it('starts empty, saves every part, and shows it again', async () => {
      const blank = await get('/auth/profile/style');
      expect(blank.statusCode).toBe(200);
      expectFullPage(blank);
      expect(blank.body).toContain('Style profile');
      expect(blank.body).not.toMatch(/value="smart-casual"[^>]*checked/);

      const res = await post('/auth/profile/style', {
        styles: ['smart-casual', 'elevated-basics'],
        budget: 'mid',
        palette: ['blue', 'white', 'grey'],
        notes: '  Office three days  ',
        // A page cached before #16 still posts the rhythm: stripped, unread.
        'times-work': '3',
        'per-work': 'week',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe('/auth/profile/style?saved=1');
      const [row] = await t.db
        .select()
        .from(styleProfile)
        .where(eq(styleProfile.userId, ownerId));
      // Sets in their list's order, whatever the post's.
      expect(row).toMatchObject({
        styles: ['elevated-basics', 'smart-casual'],
        budget: 'mid',
        palette: ['blue', 'white', 'grey'],
        notes: 'Office three days',
      });
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Style profile saved by user ${ownerId}: 2 styles, 3 colours`,
      );

      const page = await get('/auth/profile/style?saved=1');
      expectFullPage(page);
      expect(page.body).toContain('Style profile saved');
      expect(page.body).toMatch(/value="smart-casual"[^>]*checked/);
      expect(page.body).not.toContain('name="times-work"');
    });

    it("shows the week's rhythm read-only, derived from the week template (#16)", async () => {
      const unset = await get('/auth/profile/style');
      expect(unset.body).toContain('Not set yet');
      expect(unset.body).toContain('href="/auth/profile#week"');
      await saveWeekTemplate(t.db, ownerId, [
        { weekday: 1, occasion: 'work' },
        { weekday: 2, occasion: 'work' },
        { weekday: 2, occasion: 'workout' },
        { weekday: 6, occasion: 'daytime' },
      ]);
      const page = unescapeHtml((await get('/auth/profile/style')).body);
      expect(
        [...page.matchAll(/<li data-occasion="([\w-]+)">([^<]+)</g)].map(
          ([, occasion, text]) => [occasion, text],
        ),
      ).toEqual([
        ['workout', 'Workout 1× a week'],
        ['work', 'Work 2× a week'],
        ['daytime', 'Daytime 1× a week'],
      ]);
      await saveWeekTemplate(t.db, ownerId, []);
    });

    it('clears the sets on the next save', async () => {
      const res = await post('/auth/profile/style', { budget: '' });
      expect(res.statusCode).toBe(303);
      const [row] = await t.db
        .select()
        .from(styleProfile)
        .where(eq(styleProfile.userId, ownerId));
      expect(row).toMatchObject({
        styles: null,
        budget: null,
        palette: null,
        notes: null,
      });
    });

    it('refuses a style outside the set', async () => {
      const outside = await post('/auth/profile/style', { styles: ['goth'] });
      expect(outside.statusCode).toBe(400);
      const [row] = await t.db
        .select({ styles: styleProfile.styles })
        .from(styleProfile)
        .where(eq(styleProfile.userId, ownerId));
      expect(row.styles).toBeNull();
    });

    it('is the user’s own: another user sees theirs, empty', async () => {
      const theirs = await get('/auth/profile/style', { cookie: stranger });
      expect(theirs.statusCode).toBe(200);
      expect(theirs.body).not.toMatch(/value="smart-casual"[^>]*checked/);
    });

    it('is linked from the profile', async () => {
      const profile = await get('/auth/profile');
      expect(profile.body).toContain('href="/auth/profile/style"');
    });

    it('says nothing of a home city with the weather off', async () => {
      const page = await get('/auth/profile/style');
      expect(page.body).not.toContain('id="style-home"');
    });

    // A round trip per statement in production (#156): the session, then
    // the profile and the week template in one statement (#251; it was one
    // each), and no weather read with the weather off.
    it('reads the page in 2 statements', async () => {
      const { result, statements } = await recordStatements(() =>
        get('/auth/profile/style'),
      );
      expect(result.statusCode).toBe(200);
      expect(statements).toHaveLength(2); // 3 before #251
      expect(statements[1].sql).toContain('"style_profile"');
      expect(statements[1].sql).toContain('"week_template"');
      expect(statements[1].sql).not.toContain('"user_weather"');
    });
  });

  describe('plans', () => {
    it('creates the first plan active and the next one not (unlinked since #333, the routes still work)', async () => {
      const wardrobe = await get('/wardrobe');
      expect(wardrobe.body).not.toContain('href="/wardrobe/plans"');
      const form = await get('/wardrobe/plans/new');
      expect(form.statusCode).toBe(200);
      expectFullPage(form);

      const first = await createPlan('  NYC minimal  ');
      const second = await createPlan('Summer');
      expect(await plansOf(ownerId)).toEqual([
        { id: first, name: 'NYC minimal', active: true },
        { id: second, name: 'Summer', active: false },
      ]);
      const list = await get('/wardrobe/plans');
      expect(list.statusCode).toBe(200);
      expectFullPage(list);
      // Active first.
      expect(list.body.indexOf('NYC minimal')).toBeLessThan(
        list.body.indexOf('Summer'),
      );
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Plan ${first} created by user ${ownerId}`,
      );
    });

    it('creates two first plans made at the same moment (a double tap, two tabs): both saved, exactly one active, no name error', async () => {
      await t.register('racing-plans@example.com');
      const racer = await userIdOf(t, 'racing-plans@example.com');
      // A creates the user's first plan and holds its transaction open.
      let created!: () => void;
      const aCreated = new Promise<void>((resolve) => (created = resolve));
      let release!: () => void;
      const aReleased = new Promise<void>((resolve) => (release = resolve));
      const a = t.db.transaction(async (tx) => {
        const id = await insertPlan(tx, racer, { name: 'Tab A', notes: null });
        created();
        await aReleased;
        return id;
      });
      await aCreated;
      // B, from the other tab, must wait for A rather than both taking
      // "first plan, so active" and colliding on the one-active index.
      const b = insertPlan(t.db, racer, { name: 'Tab B', notes: null });
      await expect
        .poll(async () => {
          const { rows } = await t.db.execute<{ waiting: number }>(
            sql`select count(*)::int as waiting from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
          );
          return rows[0].waiting;
        })
        .toBe(1);
      release();
      const [aId, bId] = await Promise.all([a, b]);
      expect(typeof bId).toBe('number');
      expect(await plansOf(racer)).toEqual([
        { id: aId, name: 'Tab A', active: true },
        { id: bId, name: 'Tab B', active: false },
      ]);
    });

    it('refuses a blank name and one the owner already uses, in any case', async () => {
      const before = await t.db.$count(wardrobePlan);
      const blank = await post('/wardrobe/plans', {
        name: '  ',
        notes: 'kept',
      });
      expect(blank.statusCode).toBe(400);
      expectFullPage(blank);
      expect(blank.body).toContain('Give the plan a name');
      expect(blank.body).toContain('kept');
      const taken = await post('/wardrobe/plans', { name: 'nyc MINIMAL' });
      expect(taken.statusCode).toBe(400);
      expect(taken.body).toContain('You already have a plan with this name');
      expect(await t.db.$count(wardrobePlan)).toBe(before);
    });

    it('makes one plan active at a time', async () => {
      const [first, second] = await plansOf(ownerId);
      const res = await post(`/wardrobe/plans/${second.id}/activate`, {});
      expect(res.statusCode).toBe(303);
      expect((await plansOf(ownerId)).map((p) => p.active)).toEqual([
        false,
        true,
      ]);
      await post(`/wardrobe/plans/${first.id}/activate`, {});
      expect((await plansOf(ownerId)).map((p) => p.active)).toEqual([
        true,
        false,
      ]);
    });

    it('renames it, and deletes it with its items (htmx)', async () => {
      const id = await createPlan('Travel pool');
      await addItem(id, { category: 'bags', type: 'duffel' });
      const edit = await get(`/wardrobe/plans/${id}/edit`);
      expect(edit.statusCode).toBe(200);
      expect(edit.body).toContain('value="Travel pool"');
      const renamed = await post(`/wardrobe/plans/${id}`, {
        name: 'Carry-on',
        notes: 'One bag',
      });
      expect(renamed.statusCode).toBe(303);
      const deleted = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/plans/${id}`,
        headers: { 'hx-request': 'true' },
      });
      expect(deleted.statusCode).toBe(200);
      expect(hxLocationPath(deleted)).toBe('/wardrobe/plans');
      expect(await t.db.$count(wardrobePlan, eq(wardrobePlan.id, id))).toBe(0);
      expect(await t.db.$count(planItem, eq(planItem.planId, id))).toBe(0);
    });
  });

  describe('plan items and the gap view', () => {
    let planId: number;
    const garments: Record<string, number> = {};
    const items: Record<string, number> = {};

    beforeAll(async () => {
      planId = await createPlan('Gap check');
      garments.tee = await addGarment('White tee', {
        category: 'tops',
        type: 't-shirt',
        color: 'white',
        warmth: '2',
        quantity: '2',
      });
      garments.heavy = await addGarment('Heavy tee', {
        category: 'tops',
        type: 't-shirt',
        color: 'white',
        warmth: '3',
      });
      garments.merino = await addGarment('Grey merino', {
        category: 'tops',
        type: 'sweater',
        color: 'grey',
        materials: 'merino',
        condition: 'replace_soon',
      });
      garments.jeans = await addGarment('501s', {
        category: 'bottoms',
        type: 'jeans',
        color: 'blue',
        condition: 'needs_repair',
      });
      garments.old = await addGarment('Old chinos', {
        category: 'bottoms',
        type: 'chinos',
      });
      await post(`/wardrobe/${garments.old}/archive`, {});
      await createWishlistItem(t, {
        name: 'Wanted boots',
        category: 'footwear',
      });
    });

    it('adds items through the form, as stored sets and ranges', async () => {
      const form = await get(`/wardrobe/plans/${planId}/items/new`);
      expect(form.statusCode).toBe(200);
      expectFullPage(form);
      items.heavy = await addItem(planId, {
        name: 'White heavyweight tee',
        category: 'Tops',
        type: 't-shirt',
        colors: 'white',
        warmthMin: '3',
        priority: 'high',
        budget: '$48',
        note: 'Holds its shape',
      });
      const [row] = await t.db
        .select()
        .from(planItem)
        .where(eq(planItem.id, items.heavy));
      expect(row).toMatchObject({
        name: 'White heavyweight tee',
        category: 'tops',
        type: 't-shirt',
        colors: ['white'],
        materials: null,
        warmthMin: 3,
        warmthMax: 5,
        formalityMin: null,
        formalityMax: null,
        quantity: 1,
        priority: 'high',
        budget: '48.00',
        note: 'Holds its shape',
        review: 'accepted',
      });
      items.tees = await addItem(planId, {
        category: 'tops',
        type: 't-shirt',
        colors: 'white',
        quantity: '3',
      });
      items.merino = await addItem(planId, {
        category: 'tops',
        type: 'sweater',
        colors: 'grey',
        materials: 'merino',
      });
      items.jeans = await addItem(planId, {
        category: 'bottoms',
        type: 'jeans',
      });
      items.chinos = await addItem(planId, {
        category: 'bottoms',
        type: 'chinos',
      });
      items.boots = await addItem(planId, { category: 'footwear' });
    });

    it('takes a custom category the closet does not hold yet, typed with suggestions (#123)', async () => {
      const id = await createPlan('Training');
      const form = unescapeHtml(
        (await get(`/wardrobe/plans/${id}/items/new`)).body,
      );
      // A text field, as the garment form's, suggesting the built-in ones.
      expect(form).toMatch(
        /<input id="item-category" type="text" name="category" list="item-category-suggestions"/,
      );
      expect(form).not.toContain('<select id="item-category"');
      expect(form).toMatch(
        /<datalist id="item-category-suggestions">[^]*<option value="tops">Tops<\/option>/,
      );
      const itemId = await addItem(id, { category: ' Gym Kit ' });
      const [row] = await t.db
        .select({ category: planItem.category })
        .from(planItem)
        .where(eq(planItem.id, itemId));
      expect(row.category).toBe('gym kit');
      const edit = unescapeHtml(
        (await get(`/wardrobe/plans/${id}/items/${itemId}/edit`)).body,
      );
      expect(edit).toMatch(/id="item-category"[^>]*value="gym kit"/);
    });

    it('refuses a type of another category, a range the wrong way round and a bad budget, with messages', async () => {
      const before = await t.db.$count(planItem);
      const res = await post(`/wardrobe/plans/${planId}/items`, {
        category: 'tops',
        type: 'jeans',
        warmthMin: '4',
        warmthMax: '2',
        quantity: '0',
        budget: 'lots',
      });
      expect(res.statusCode).toBe(400);
      expectFullPage(res);
      expect(res.body).toContain('Choose a type of this category, or any type');
      expect(res.body).toContain('The first end must not be above the second');
      expect(res.body).toContain('Copies must be a whole number from 1 to 30');
      expect(res.body).toContain('Enter a price such as 49.90');
      const blank = await post(`/wardrobe/plans/${planId}/items`, {
        category: ' ',
      });
      expect(blank.statusCode).toBe(400);
      expect(blank.body).toContain('Choose a category');
      const outside = await post(`/wardrobe/plans/${planId}/items`, {
        category: 'tops',
        colors: 'mauve',
      });
      expect(outside.statusCode).toBe(400);
      expect(await t.db.$count(planItem)).toBe(before);
    });

    it('draws the items as cards in sections by role, top to toe, each with its status and why', async () => {
      const page = await get(`/wardrobe/plans/${planId}`);
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      const html = unescapeHtml(page.body);
      expect(statuses(html)).toEqual({
        // The one heavy tee chooses first (fewest candidates).
        [items.heavy]: 'owned',
        // The white tee's 2 copies of 3.
        [items.tees]: 'partly',
        // Only a replace_soon copy: the gap to refill.
        [items.merino]: 'missing',
        // needs_repair still counts.
        [items.jeans]: 'owned',
        // Archived chinos and a wishlist item are not owned clothes.
        [items.chinos]: 'missing',
        [items.boots]: 'missing',
      });
      expect(html).toContain('2 owned · 1 partly · 3 missing');
      // #295: a section per role, top to toe, each headed with its count.
      const at = (id: string) => html.indexOf(`id="${id}"`);
      expect(at('plan-role-top')).toBeGreaterThan(-1);
      expect(at('plan-role-top')).toBeLessThan(at('plan-role-bottom'));
      expect(at('plan-role-bottom')).toBeLessThan(at('plan-role-footwear'));
      for (const [role, label, count] of [
        ['top', 'Tops', 3],
        ['bottom', 'Bottoms', 2],
        ['footwear', 'Shoes', 1],
      ] as const) {
        expect(html).toMatch(
          new RegExp(
            `id="plan-role-${role}-title"[^>]*>${label} <span[^>]*>· ${count}</span>`,
          ),
        );
      }
      // In a section the gaps first, each card's status a chip on its photo.
      expect(at(`plan-item-${items.merino}`)).toBeLessThan(
        at(`plan-item-${items.tees}`),
      );
      expect(at(`plan-item-${items.tees}`)).toBeLessThan(
        at(`plan-item-${items.heavy}`),
      );
      const chips = [
        ...html.matchAll(
          /<span class="badge[^"]*"[^>]*data-status-chip="">([^<]*)</g,
        ),
      ].map((m) => m[1]);
      expect(chips).toEqual(
        expect.arrayContaining(['To buy', '2 of 3', 'Owned']),
      );
      // Nothing linked to buy yet: the item says so.
      expect(html).toContain('No options yet');
      expect(html).toContain('Worn out, to replace: Grey merino');
      expect(html).toContain('1 more to go');
      expect(html).toContain('needs repair');
      expect(html).toContain(`href="/wardrobe/${garments.heavy}"`);
      expect(html).toContain('$48.00 each');
    });

    it('edits an item, and a garment bought or retagged moves the view with no write to the plan', async () => {
      const edit = await get(
        `/wardrobe/plans/${planId}/items/${items.tees}/edit`,
      );
      expect(edit.statusCode).toBe(200);
      expect(edit.body).toMatch(/name="quantity"[^>]*value="3"/);
      const res = await post(`/wardrobe/plans/${planId}/items/${items.tees}`, {
        category: 'tops',
        type: 't-shirt',
        colors: 'white',
        quantity: '2',
        priority: 'medium',
      });
      expect(res.statusCode).toBe(303);
      await addGarment('Chelsea boots', {
        category: 'footwear',
        type: 'boots',
      });
      const html = (await get(`/wardrobe/plans/${planId}`)).body;
      expect(statuses(html)[items.tees]).toBe('owned');
      expect(statuses(html)[items.boots]).toBe('owned');
    });

    it('shows what the agent proposed apart, unmatched, until accepted or declined', async () => {
      const [proposal, declined] = await insertItems(
        t.db,
        planId,
        [
          {
            name: 'Navy blazer',
            category: 'outerwear',
            type: 'blazer',
            colors: ['blue'],
            materials: null,
            warmthMin: null,
            warmthMax: null,
            formalityMin: 3,
            formalityMax: 4,
            quantity: 1,
            priority: 'high',
            budget: '300.00',
            note: 'Meeting days',
          },
          {
            name: 'Second parka',
            category: 'outerwear',
            type: 'parka',
            colors: null,
            materials: null,
            warmthMin: null,
            warmthMax: null,
            formalityMin: null,
            formalityMax: null,
            quantity: 1,
            priority: 'low',
            budget: null,
            note: null,
          },
        ],
        { review: 'proposed' },
      );
      const page = unescapeHtml((await get(`/wardrobe/plans/${planId}`)).body);
      expect(statuses(page)[proposal]).toBe('proposed');
      expect(page).toContain('2 proposed by your agent');
      expect(page).toContain('To review');
      // Not counted in the tally.
      expect(page).toContain('4 owned · 0 partly · 2 missing');

      const accepted = await post(
        `/wardrobe/plans/${planId}/items/${proposal}/accept`,
        {},
      );
      expect(accepted.statusCode).toBe(303);
      // Don't buy keeps the row, apart and unmatched, for the agent to see.
      const decline = await post(
        `/wardrobe/plans/${planId}/items/${declined}/decline`,
        { note: 'One parka is enough' },
      );
      expect(decline.statusCode).toBe(303);
      const after = unescapeHtml((await get(`/wardrobe/plans/${planId}`)).body);
      expect(statuses(after)[proposal]).toBe('missing');
      expect(after).toMatch(
        new RegExp(`id="plan-item-${declined}" data-status="declined"`),
      );
      expect(after).toContain('Your note: One parka is enough');
      // The accepted blazer counts; the declined parka does not.
      expect(after).toContain('4 owned · 0 partly · 3 missing');
      expect(after).not.toContain('Proposed by your agent');
      // Deleting stays the edit form's.
      const dropped = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/plans/${planId}/items/${declined}`,
        headers: { 'hx-request': 'true' },
      });
      expect(hxLocationPath(dropped)).toBe(`/wardrobe/plans/${planId}`);
    });

    it('duplicates a plan with its items, naming each copy apart', async () => {
      const first = await post(`/wardrobe/plans/${planId}/duplicate`, {});
      expect(first.statusCode).toBe(303);
      const second = await post(`/wardrobe/plans/${planId}/duplicate`, {});
      const names = (await plansOf(ownerId)).map((p) => p.name);
      expect(names).toContain('Gap check (copy)');
      expect(names).toContain('Gap check (copy 2)');
      const copyId = Number(
        /\/wardrobe\/plans\/(\d+)/.exec(String(second.headers.location))![1],
      );
      const copied = await t.db
        .select({ category: planItem.category, type: planItem.type })
        .from(planItem)
        .where(eq(planItem.planId, copyId))
        .orderBy(asc(planItem.id));
      const original = await t.db
        .select({ category: planItem.category, type: planItem.type })
        .from(planItem)
        .where(eq(planItem.planId, planId))
        .orderBy(asc(planItem.id));
      expect(copied).toEqual(original);
      // Never made active over the one the owner chose.
      expect(
        (await plansOf(ownerId)).find((p) => p.id === copyId)?.active,
      ).toBe(false);
    });

    it('names two duplicates made at the same moment apart, never a 500 (#123)', async () => {
      const id = await createPlan('Twin taps');
      const [a, b] = await whileOwnerLocked(ownerId, 2, () => [
        post(`/wardrobe/plans/${id}/duplicate`, {}),
        post(`/wardrobe/plans/${id}/duplicate`, {}),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([303, 303]);
      const names = (await plansOf(ownerId)).map((p) => p.name);
      expect(names).toContain('Twin taps (copy)');
      expect(names).toContain('Twin taps (copy 2)');
    });

    it('cuts a long plan’s name so its copy fits the plan form (#123)', async () => {
      const long = `${'Capsule for the long wet autumn '.repeat(3)}ok`.slice(
        0,
        PLAN_NAME_MAX,
      );
      const id = await createPlan(long);
      const names: string[] = [];
      for (let copy = 0; copy < 2; copy += 1) {
        const res = await post(`/wardrobe/plans/${id}/duplicate`, {});
        expect(res.statusCode).toBe(303);
        const copyId = Number(
          /\/wardrobe\/plans\/(\d+)/.exec(String(res.headers.location))![1],
        );
        const { name } = (await plansOf(ownerId)).find((p) => p.id === copyId)!;
        names.push(name);
        expect([...name].length).toBeLessThanOrEqual(PLAN_NAME_MAX);
        // The edit form takes the name back as it is.
        const saved = await post(`/wardrobe/plans/${copyId}`, {
          name,
          notes: '',
        });
        expect(saved.statusCode, saved.body).toBe(303);
      }
      expect(names[0]).toMatch(/^Capsule for the long wet autumn .* \(copy\)$/);
      expect(names[1]).toMatch(/ \(copy 2\)$/);
    });
  });

  describe('start from a wardrobe', () => {
    let theoId: number;
    let theo: string;

    beforeAll(async () => {
      theo = await t.register('theo-plans@example.com');
      theoId = await userIdOf(t, 'theo-plans@example.com');
      await t.db
        .update(user)
        .set({ firstName: 'Theo' })
        .where(eq(user.id, theoId));
      await addGarment(
        'White tee',
        {
          category: 'tops',
          type: 't-shirt',
          color: 'white',
          quantity: '3',
          product: '1',
          price: '24.90',
        },
        theo,
      );
      await addGarment(
        'Heavy tee',
        {
          category: 'tops',
          type: 't-shirt',
          color: 'white',
          product: '1',
          price: '48',
        },
        theo,
      );
      await addGarment(
        'Loafers',
        { category: 'footwear', type: 'loafers', color: 'brown' },
        theo,
      );
      const invite = await createInvite(t.db, theoId, 'VIEW');
      expect(
        (await acceptInvite(t.db, invite.inviteToken, ownerId)).accepted,
      ).toBe(true);
    });

    it('offers each shared wardrobe and the owner’s own closet', async () => {
      const list = unescapeHtml((await get('/wardrobe/plans')).body);
      expect(list).toContain(`value="${theoId}"`);
      expect(list).toContain('Theo’s wardrobe');
      expect(list).toContain(`value="${ownerId}"`);
    });

    it('copies the shared closet as a plan of the owner’s, grouped with quantities', async () => {
      const res = await post('/wardrobe/plans/from-wardrobe', {
        ownerId: String(theoId),
      });
      expect(res.statusCode).toBe(303);
      const id = Number(
        /\/wardrobe\/plans\/(\d+)\?created=1$/.exec(
          String(res.headers.location),
        )![1],
      );
      const [plan] = await t.db
        .select()
        .from(wardrobePlan)
        .where(eq(wardrobePlan.id, id));
      expect(plan).toMatchObject({
        ownerId,
        name: 'Like Theo’s wardrobe',
      });
      const rows = await t.db
        .select({
          category: planItem.category,
          type: planItem.type,
          colors: planItem.colors,
          quantity: planItem.quantity,
          budget: planItem.budget,
          note: planItem.note,
        })
        .from(planItem)
        .where(eq(planItem.planId, id))
        .orderBy(asc(planItem.id));
      expect(rows).toEqual([
        {
          category: 'tops',
          type: 't-shirt',
          colors: ['white'],
          quantity: 4,
          budget: '48.00',
          note: 'From Theo’s: White tee, Heavy tee',
        },
        {
          category: 'footwear',
          type: 'loafers',
          colors: ['brown'],
          quantity: 1,
          budget: null,
          note: 'From Theo’s: Loafers',
        },
      ]);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Plan ${id} started by user ${ownerId} from wardrobe ${theoId}: 2 items from 3 garments`,
      );
      // Theo's wardrobe is untouched, and has no plan.
      expect(
        await t.db.$count(wardrobePlan, eq(wardrobePlan.ownerId, theoId)),
      ).toBe(0);
    });

    it('names two plans started at the same moment apart, never a 500 (#123)', async () => {
      const racer = await t.register('racing-starts@example.com');
      const racerId = await userIdOf(t, 'racing-starts@example.com');
      const start = () =>
        post('/wardrobe/plans/from-wardrobe', { ownerId: racerId }, racer);
      const [a, b] = await whileOwnerLocked(racerId, 2, () => [
        start(),
        start(),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([303, 303]);
      expect((await plansOf(racerId)).map((p) => p.name)).toEqual([
        'My closet',
        'My closet 2',
      ]);
    });

    it('refuses a wardrobe nobody shared, as if it did not exist', async () => {
      const before = await t.db.$count(wardrobePlan);
      const res = await post(
        '/wardrobe/plans/from-wardrobe',
        { ownerId: String(ownerId) },
        stranger,
      );
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('Gap check');
      expect(await t.db.$count(wardrobePlan)).toBe(before);
    });
  });

  describe('privacy', () => {
    it('is a 404 for anyone else, and changes nothing', async () => {
      const plan = (await plansOf(ownerId)).find(
        (p) => p.name === 'Gap check',
      )!;
      const [item] = await t.db
        .select({ id: planItem.id })
        .from(planItem)
        .where(eq(planItem.planId, plan.id));
      for (const url of [
        `/wardrobe/plans/${plan.id}`,
        `/wardrobe/plans/${plan.id}/edit`,
        `/wardrobe/plans/${plan.id}/items/new`,
      ]) {
        const res = await get(url, { cookie: stranger });
        expect(res.statusCode, url).toBe(404);
        expect(res.body).not.toContain(plan.name);
      }
      const rename = await post(
        `/wardrobe/plans/${plan.id}`,
        { name: 'Mine now' },
        stranger,
      );
      expect(rename.statusCode).toBe(404);
      const activate = await post(
        `/wardrobe/plans/${plan.id}/activate`,
        {},
        stranger,
      );
      expect(activate.statusCode).toBe(404);
      const deleted = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/plans/${plan.id}/items/${item.id}`,
        headers: { cookie: stranger, 'hx-request': 'true' },
      });
      expect(deleted.statusCode).toBe(404);
      expect(await t.db.$count(planItem, eq(planItem.id, item.id))).toBe(1);
      expect(await plansOf(ownerId)).toContainEqual(
        expect.objectContaining({ id: plan.id, name: plan.name }),
      );
      // The stranger's own list is theirs: empty.
      const theirs = await get('/wardrobe/plans', { cookie: stranger });
      expect(theirs.body).not.toContain(plan.name);
    });

    it('never lets an item of one plan be written through another plan’s path', async () => {
      const a = await createPlan('Path A');
      const b = await createPlan('Path B');
      const item = await addItem(b, { category: 'tops' });
      const edit = await post(`/wardrobe/plans/${a}/items/${item}`, {
        category: 'bottoms',
      });
      expect(edit.statusCode).toBe(404);
      const [row] = await t.db
        .select({ category: planItem.category, planId: planItem.planId })
        .from(planItem)
        .where(and(eq(planItem.id, item)));
      expect(row).toEqual({ category: 'tops', planId: b });
    });
  });
});

/**
 * The style page and the weather's home city (#14): shown read-only from
 * user_weather, with the way to change it (Profile › Weather); the style
 * profile never stores a location of its own.
 */
describe('the style profile beside the weather', () => {
  let stub: WeatherStub;
  let t: TestApp;

  beforeAll(async () => {
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await stub?.close();
  });

  it('offers to set a home city when there is none', async () => {
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: '/auth/profile/style' })).body,
    );
    expect(page).toMatch(
      /id="style-home"[\s\S]*href="\/auth\/profile#weather"[^>]*>Add your city for the weather/,
    );
  });

  it('shows the home city read-only, linking to Weather to change it, and stores none of it', async () => {
    await setHome(t.db, t.owner.id, {
      name: 'Fort Greene, Brooklyn',
      location: { latitude: 40.69, longitude: -73.97 },
    });
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: '/auth/profile/style' })).body,
    );
    expect(page).toContain('Home: Fort Greene, Brooklyn');
    expect(page).toMatch(
      /id="style-home"[\s\S]*href="\/auth\/profile#weather"[^>]*>Change it in Weather/,
    );
    // No field posts it: saving the style profile cannot write a location.
    expect(page).not.toMatch(/name="(home|city|location)/);
    const saved = await t.inject({
      method: 'POST',
      url: '/auth/profile/style',
      payload: { styles: 'minimal', home: 'Elsewhere' },
    });
    expect(saved.statusCode).toBe(303);
    const settings = await findWeatherSettings(t.db, t.owner.id);
    expect(settings.home?.name).toBe('Fort Greene, Brooklyn');
  });

  // The home city rides in the page's one statement with the profile and
  // the week template (#251; they were three).
  it('reads the page in 2 statements, the home city among them', async () => {
    const { result, statements } = await recordStatements(() =>
      t.inject({ method: 'GET', url: '/auth/profile/style' }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Home: Fort Greene, Brooklyn');
    expect(statements).toHaveLength(2); // 4 before #251
    for (const table of ['style_profile', 'week_template', 'user_weather']) {
      expect(statements[1].sql).toContain(`"${table}"`);
    }
  });
});
