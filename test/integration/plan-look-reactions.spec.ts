import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, planItem, planLook } from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import { proposeLook, reactToLooks } from '../../src/web/plans/looks';
import { addItems } from '../../src/web/plans/queries';
import type { PlanItemFields } from '../../src/web/plans/validation';
import { deleteGarment } from '../../src/web/wardrobe/queries';
import type { GarmentStatus } from '../../src/wardrobe/status';
import { recordStatements } from '../support/query-recorder';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { expectFullPage } from './pages';

/**
 * Plan looks in the app (#291): the Looks strip on the review page and the
 * plan page (a tile per look, loved first: its collage with the pieces to
 * buy and the missing ones marked, its name, occasion and the agent's
 * note), the review's reactions riding in "Accept these" (only the looks
 * the strip drew are touched; Change this needs a note), the plan page's
 * own small posts, and the looks sent back or turned down listed apart.
 * The writer and the machine are plan-looks.spec.ts's and
 * look-reaction.spec.ts's; the matrix rows, authorization-plans.spec.ts.
 */
describe('plan looks in the app', () => {
  let t: TestApp;
  let seq = 0;

  const get = (url: string, cookie: string) =>
    t.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, payload: object, cookie: string) =>
    t.inject({ method: 'POST', url, payload, headers: { cookie } });

  const item = (category: string): PlanItemFields => ({
    name: null,
    category,
    type: null,
    colors: null,
    materials: null,
    warmthMin: null,
    warmthMax: null,
    formalityMin: null,
    formalityMax: null,
    quantity: 1,
    priority: 'medium',
    budget: null,
    note: null,
  });

  const newGarment = async (
    ownerId: number,
    status: GarmentStatus,
    category: string,
    name: string,
  ) =>
    (
      await t.db
        .insert(garment)
        .values({
          ownerId,
          status,
          category,
          name,
          shareableId: randomUUID(),
        })
        .returning({ id: garment.id })
    )[0].id;

  /**
   * A fresh owner with a plan holding an accepted footwear item, a
   * wishlist candidate for it and two closet garments; and `look(name)`,
   * a look of the closet pieces and the candidate, through the writer.
   */
  const fixture = async (options: { proposedItem?: boolean } = {}) => {
    const email = `looker-${++seq}@example.com`;
    const cookie = await t.register(email);
    const ownerId = await userIdOf(t, email);
    const created = await post(
      '/wardrobe/plans',
      { name: `Looks ${seq}`, notes: '' },
      cookie,
    );
    const planId = Number(
      /^\/wardrobe\/plans\/(\d+)\?/.exec(String(created.headers.location))![1],
    );
    const [itemId] = (await addItems(
      t.db,
      ownerId,
      planId,
      [item('footwear')],
      { review: options.proposedItem ? 'proposed' : 'accepted' },
    ))!;
    const candidate = await newGarment(
      ownerId,
      'wishlist',
      'footwear',
      'Suede loafers',
    );
    await changeCandidates(t.db, ownerId, {
      add: { itemIds: [itemId], garmentIds: [candidate] },
    });
    const top = await newGarment(ownerId, 'closet', 'tops', 'Oxford shirt');
    const bottom = await newGarment(ownerId, 'closet', 'bottoms', 'Chinos');
    const look = async (name: string, garmentIds = [top, bottom, candidate]) =>
      (
        await proposeLook(
          t.db,
          ownerId,
          planId,
          { name, occasion: 'work', note: `Why ${name} works` },
          garmentIds,
        )
      ).id;
    return { cookie, ownerId, planId, itemId, candidate, top, bottom, look };
  };

  const reactionsOf = async (ids: number[]) =>
    new Map(
      (
        await t.db
          .select({
            id: planLook.id,
            reaction: planLook.reaction,
            ownerNote: planLook.ownerNote,
          })
          .from(planLook)
          .where(inArray(planLook.id, ids))
      ).map((row) => [row.id, { reaction: row.reaction, note: row.ownerNote }]),
    );

  /** The look ids the strip drew, in its order (each tile's hidden `look`). */
  const lookTiles = (html: string) =>
    [...html.matchAll(/name="look" value="(\d+)"/g)].map((m) => Number(m[1]));

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('the review page', () => {
    it('draws the looks as a strip, loved first, with the pieces to buy and missing marked', async () => {
      const f = await fixture();
      const first = await f.look('Office Tuesday');
      const loved = await f.look('Friday drinks', [f.top, f.candidate]);
      const revise = await f.look('Weekend', [f.bottom, f.candidate]);
      const declined = await f.look('Too plain', [f.top, f.bottom]);
      await reactToLooks(t.db, f.ownerId, f.planId, 'love', [
        { lookId: loved },
      ]);
      await reactToLooks(t.db, f.ownerId, f.planId, 'change', [
        { lookId: revise, note: 'Brighter shoes' },
      ]);
      await reactToLooks(t.db, f.ownerId, f.planId, 'decline', [
        { lookId: declined, note: 'Too plain' },
      ]);

      const res = await get(`/wardrobe/plans/${f.planId}/review`, f.cookie);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      // No proposed item, but looks to react to: the form is there.
      expect(html).toContain('id="review-form"');
      expect(html).toContain('id="review-looks"');
      expect(html).toContain('Looks <span class="font-normal text-muted">· 2');
      expect(lookTiles(html)).toEqual([loved, first]);
      const tile = html.slice(
        html.indexOf(`id="review-look-${first}"`),
        html.indexOf('</textarea>', html.indexOf(`id="review-look-${first}"`)),
      );
      expect(tile).toContain('Office Tuesday');
      expect(tile).toContain('Work · 1 to buy');
      expect(tile).toContain('Why Office Tuesday works');
      expect(tile.match(/data-to-buy=""/g)).toHaveLength(1);
      for (const pick of ['love', 'change', 'decline', '']) {
        expect(tile).toContain(`name="look-${first}" value="${pick}"`);
      }
      expect(tile).toContain('name="lookNote"');
      // The first tile is centred; the loved one leads the strip.
      expect(html).toMatch(
        new RegExp(
          `id="review-look-${loved}" data-look="${loved}" data-reaction="loved"`,
        ),
      );
      // Sent back and turned down: apart, with the owner's note.
      const apart = (id: string) =>
        html.slice(
          html.indexOf(`id="${id}"`),
          html.indexOf('</section>', html.indexOf(`id="${id}"`)),
        );
      expect(apart('review-looks-revise')).toContain(
        'Your note: Brighter shoes',
      );
      expect(apart('review-looks-revise')).toContain(`id="look-${revise}"`);
      expect(apart('review-looks-declined')).toContain('Your note: Too plain');
      expect(apart('review-looks-declined')).toContain(`id="look-${declined}"`);

      // The candidate deleted from the wishlist empties its slot: a missing piece.
      await deleteGarment(t.db, f.candidate, f.ownerId, 'wishlist');
      const after = unescapeHtml(
        (await get(`/wardrobe/plans/${f.planId}/review`, f.cookie)).body,
      );
      const firstAfter = after.slice(
        after.indexOf(`id="review-look-${first}"`),
      );
      expect(firstAfter).toContain('Work · 1 piece missing');
      expect(firstAfter).toContain('data-missing-piece=""');
    });

    it('says there is nothing to review once no item or look waits', async () => {
      const f = await fixture();
      const look = await f.look('Office Tuesday');
      await reactToLooks(t.db, f.ownerId, f.planId, 'decline', [
        { lookId: look },
      ]);
      const res = await get(`/wardrobe/plans/${f.planId}/review`, f.cookie);
      expect(unescapeHtml(res.body)).toContain(
        'Nothing left to review: every proposal is decided.',
      );
      expect(res.body).not.toContain('id="review-form"');
      expect(res.body).toContain('id="review-looks-declined"');
    });

    it('reads the page in 5 statements', async () => {
      const f = await fixture({ proposedItem: true });
      await f.look('Office Tuesday');
      const { result, statements } = await recordStatements(() =>
        get(`/wardrobe/plans/${f.planId}/review`, f.cookie),
      );
      expect(result.statusCode).toBe(200);
      // The session, the plan, its items, its candidates, its looks.
      expect(statements).toHaveLength(5);
    });
  });

  describe('Accept these', () => {
    it('reacts to the looks the strip drew, with the item picks, in one post', async () => {
      const f = await fixture({ proposedItem: true });
      const love = await f.look('Office Tuesday');
      const change = await f.look('Friday drinks', [f.top, f.candidate]);
      const decline = await f.look('Weekend', [f.bottom, f.candidate]);
      const untouched = await f.look('Errands', [f.top, f.bottom]);
      const drawn = unescapeHtml(
        (await get(`/wardrobe/plans/${f.planId}/review`, f.cookie)).body,
      );
      const shown = lookTiles(drawn);
      expect(shown).toEqual([love, change, decline, untouched]);
      // The agent proposes another look after the page was drawn.
      const blazer = await newGarment(
        f.ownerId,
        'closet',
        'outerwear',
        'Blazer',
      );
      const later = await f.look('Late idea', [blazer, f.top]);

      const res = await post(
        `/wardrobe/plans/${f.planId}/review`,
        {
          shown: [String(f.itemId)],
          pick: [`${f.itemId}:keep`],
          look: shown.map(String),
          lookNote: ['', '  Darker trousers  ', 'Not my colours', ''],
          [`look-${love}`]: 'love',
          [`look-${change}`]: 'change',
          [`look-${decline}`]: 'decline',
          [`look-${untouched}`]: '',
        },
        f.cookie,
      );
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(
        `/wardrobe/plans/${f.planId}?reviewed=1`,
      );
      expect(
        await reactionsOf([love, change, decline, untouched, later]),
      ).toEqual(
        new Map([
          [love, { reaction: 'loved', note: null }],
          [change, { reaction: 'revise', note: 'Darker trousers' }],
          [decline, { reaction: 'declined', note: 'Not my colours' }],
          [untouched, { reaction: 'proposed', note: null }],
          [later, { reaction: 'proposed', note: null }],
        ]),
      );
      const [{ review }] = await t.db
        .select({ review: planItem.review })
        .from(planItem)
        .where(eq(planItem.id, f.itemId));
      expect(review).toBe('accepted');

      // A second post of the same page moves nothing the machine refuses:
      // Love it again is a self-move, left as it is.
      const again = await post(
        `/wardrobe/plans/${f.planId}/review`,
        {
          look: [String(love)],
          lookNote: [''],
          [`look-${love}`]: 'love',
        },
        f.cookie,
      );
      expect(again.statusCode, again.body).toBe(303);
      expect((await reactionsOf([love])).get(love)?.reaction).toBe('loved');
    });

    it('leaves a look of another plan, and of another user, as it is', async () => {
      const f = await fixture({ proposedItem: true });
      const mine = await f.look('Office Tuesday');
      const other = await fixture();
      const sameOwnerLook = await other.look('Elsewhere');
      const res = await post(
        `/wardrobe/plans/${f.planId}/review`,
        {
          shown: [String(f.itemId)],
          pick: [`${f.itemId}:keep`],
          look: [String(mine), String(sameOwnerLook)],
          lookNote: ['', ''],
          [`look-${mine}`]: 'love',
          [`look-${sameOwnerLook}`]: 'decline',
        },
        f.cookie,
      );
      expect(res.statusCode, res.body).toBe(303);
      expect(await reactionsOf([mine, sameOwnerLook])).toEqual(
        new Map([
          [mine, { reaction: 'loved', note: null }],
          [sameOwnerLook, { reaction: 'proposed', note: null }],
        ]),
      );
    });

    it('refuses Change this without a note: the page as posted, 400, nothing written', async () => {
      const f = await fixture({ proposedItem: true });
      const love = await f.look('Office Tuesday');
      const change = await f.look('Friday drinks', [f.top, f.candidate]);
      const res = await post(
        `/wardrobe/plans/${f.planId}/review`,
        {
          shown: [String(f.itemId)],
          pick: [`${f.itemId}:keep`],
          look: [String(love), String(change)],
          lookNote: ['Lovely', '   '],
          [`look-${love}`]: 'love',
          [`look-${change}`]: 'change',
        },
        f.cookie,
      );
      expect(res.statusCode).toBe(400);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(html).toContain('Nothing is saved yet: fix what is marked below.');
      expect(html).toContain(
        `id="review-look-note-${change}-error" class="text-xs text-error"`,
      );
      // As posted: the reactions checked, the note kept, the marked look centred.
      expect(html).toMatch(
        new RegExp(
          `name="look-${love}" value="love" class="[^"]*"[^>]*checked`,
        ),
      );
      expect(html).toMatch(
        new RegExp(
          `name="look-${change}" value="change" class="[^"]*"[^>]*checked`,
        ),
      );
      expect(html).toContain('>Lovely</textarea>');
      expect(html).toMatch(
        new RegExp(`id="review-look-${change}" data-look="${change}"`),
      );
      expect(html).toContain(`data-snap-value="${change}" data-selected=""`);
      expect(html).not.toContain(`data-snap-value="${love}" data-selected=""`);
      expect(await reactionsOf([love, change])).toEqual(
        new Map([
          [love, { reaction: 'proposed', note: null }],
          [change, { reaction: 'proposed', note: null }],
        ]),
      );
      const [{ review }] = await t.db
        .select({ review: planItem.review })
        .from(planItem)
        .where(eq(planItem.id, f.itemId));
      expect(review).toBe('proposed');
    });

    it('refuses a post whose notes do not pair with its looks: the page as it stands, 400', async () => {
      const f = await fixture();
      const look = await f.look('Office Tuesday');
      for (const payload of [
        { look: [String(look)], lookNote: [] },
        { look: [String(look), String(look)], lookNote: ['', ''] },
      ]) {
        const res = await post(
          `/wardrobe/plans/${f.planId}/review`,
          { ...payload, [`look-${look}`]: 'love' },
          f.cookie,
        );
        expect(res.statusCode).toBe(400);
        expect(unescapeHtml(res.body)).toContain(
          'Some of these items changed since the page was drawn.',
        );
      }
      expect((await reactionsOf([look])).get(look)?.reaction).toBe('proposed');
    });
  });

  describe('the plan page', () => {
    it('reads the page in 6 statements', async () => {
      const f = await fixture();
      await f.look('Office Tuesday');
      const { result, statements } = await recordStatements(() =>
        get(`/wardrobe/plans/${f.planId}`, f.cookie),
      );
      expect(result.statusCode).toBe(200);
      expect(statements).toHaveLength(6);
    });

    it('leads with the strip and lists the looks sent back or turned down apart', async () => {
      const f = await fixture();
      const first = await f.look('Office Tuesday');
      const loved = await f.look('Friday drinks', [f.top, f.candidate]);
      const revise = await f.look('Weekend', [f.bottom, f.candidate]);
      const declined = await f.look('Too plain', [f.top, f.bottom]);
      await reactToLooks(t.db, f.ownerId, f.planId, 'love', [
        { lookId: loved },
      ]);
      await reactToLooks(t.db, f.ownerId, f.planId, 'change', [
        { lookId: revise, note: 'Brighter shoes' },
      ]);
      await reactToLooks(t.db, f.ownerId, f.planId, 'decline', [
        { lookId: declined },
      ]);
      const res = await get(`/wardrobe/plans/${f.planId}`, f.cookie);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(html.indexOf('id="plan-looks"')).toBeLessThan(
        html.indexOf('id="plan-role-'),
      );
      const strip = [...html.matchAll(/id="look-(\d+)" data-look/g)].map((m) =>
        Number(m[1]),
      );
      expect(strip).toEqual([loved, first]);
      const action = (lookId: number, move: string) =>
        `action="/wardrobe/plans/${f.planId}/looks/${lookId}/${move}"`;
      // A look to review: Love it, Not for me, Change this…; a loved one no Love it.
      expect(html).toContain(action(first, 'love'));
      expect(html).toContain(action(first, 'decline'));
      expect(html).toContain(
        `href="/wardrobe/plans/${f.planId}/looks/${first}/change"`,
      );
      expect(html).not.toContain(action(loved, 'love'));
      expect(html).toContain(
        `href="/wardrobe/plans/${f.planId}/looks/${loved}/change"`,
      );
      expect(html).toContain('id="plan-looks-revise"');
      expect(html).toContain('Your note: Brighter shoes');
      expect(html).toContain(action(revise, 'love'));
      expect(html).toContain('Love it as it is');
      expect(html).toContain('id="plan-looks-declined"');
      expect(html).toContain(action(declined, 'reconsider'));
    });

    it('offers Review for a plan whose only proposal is a look: the plan page and the list', async () => {
      const f = await fixture();
      await f.look('Only look');
      const planHtml = unescapeHtml(
        (await get(`/wardrobe/plans/${f.planId}`, f.cookie)).body,
      );
      expect(planHtml).toContain('id="plan-review"');
      expect(planHtml).toContain('1 proposed by your agent');
      const listHtml = unescapeHtml(
        (await get('/wardrobe/plans', f.cookie)).body,
      );
      expect(listHtml).toContain(`href="/wardrobe/plans/${f.planId}/review"`);
      expect(listHtml).toContain('1 proposed by your agent');

      const none = await fixture();
      expect(
        unescapeHtml(
          (await get(`/wardrobe/plans/${none.planId}`, none.cookie)).body,
        ),
      ).not.toContain('id="plan-review"');
    });

    it('moves a look with its own posts, a 409 when it moved already', async () => {
      const f = await fixture();
      const look = await f.look('Office Tuesday');
      const url = (move: string) =>
        `/wardrobe/plans/${f.planId}/looks/${look}/${move}`;

      const loved = await post(url('love'), {}, f.cookie);
      expect(loved.statusCode).toBe(303);
      expect(loved.headers.location).toBe(
        `/wardrobe/plans/${f.planId}?saved=1`,
      );
      expect((await reactionsOf([look])).get(look)?.reaction).toBe('loved');
      expect((await post(url('love'), {}, f.cookie)).statusCode).toBe(409);

      const form = await get(url('change'), f.cookie);
      expect(form.statusCode).toBe(200);
      expectFullPage(form);
      expect(unescapeHtml(form.body)).toContain('Change Office Tuesday');
      const blank = await post(url('change'), { note: '  ' }, f.cookie);
      expect(blank.statusCode).toBe(400);
      expect(unescapeHtml(blank.body)).toContain(
        'Say what to change: your agent has nothing to go on without a note.',
      );
      expect((await reactionsOf([look])).get(look)?.reaction).toBe('loved');
      const changed = await post(
        url('change'),
        { note: 'Swap the shirt' },
        f.cookie,
      );
      expect(changed.statusCode).toBe(303);
      expect((await reactionsOf([look])).get(look)).toEqual({
        reaction: 'revise',
        note: 'Swap the shirt',
      });

      const declined = await post(url('decline'), { note: 'Not me' }, f.cookie);
      expect(declined.statusCode).toBe(303);
      expect((await reactionsOf([look])).get(look)).toEqual({
        reaction: 'declined',
        note: 'Not me',
      });
      const back = await post(url('reconsider'), {}, f.cookie);
      expect(back.statusCode).toBe(303);
      expect((await reactionsOf([look])).get(look)).toEqual({
        reaction: 'proposed',
        note: null,
      });
    });

    it('is a 404 for a look of another plan, and for another owner', async () => {
      const f = await fixture();
      const g = await fixture();
      const theirs = await g.look('Office Tuesday');
      const mine = await f.look('Office Tuesday');
      // Another plan's look under this plan's path.
      const other = await post(
        `/wardrobe/plans/${f.planId}/looks/${theirs}/love`,
        {},
        f.cookie,
      );
      expect(other.statusCode).toBe(404);
      expect(
        (
          await get(
            `/wardrobe/plans/${f.planId}/looks/${theirs}/change`,
            f.cookie,
          )
        ).statusCode,
      ).toBe(404);
      // Another owner's plan.
      const stranger = await post(
        `/wardrobe/plans/${f.planId}/looks/${mine}/love`,
        {},
        g.cookie,
      );
      expect(stranger.statusCode).toBe(404);
      expect(await reactionsOf([theirs, mine])).toEqual(
        new Map([
          [theirs, { reaction: 'proposed', note: null }],
          [mine, { reaction: 'proposed', note: null }],
        ]),
      );
    });
  });
});
