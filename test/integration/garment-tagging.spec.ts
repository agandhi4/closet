import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { createTestApp, type TestApp } from './harness';
import {
  expectFragment,
  expectNativePostForms,
  expectNoRawI18nKeys,
} from './pages';

/**
 * Tagging mode (#12, slice 12c): the wardrobe prompts while garments lack
 * their type (where the category has types), warmth (where the role has
 * one) or formality; /wardrobe/tag shows them one at a time, newest first;
 * a tap saves at once and a type fills its presets only where nothing is
 * set; Next moves past (`?before=`), so a garment left alone waits for the
 * next pass.
 */

type Props = Record<string, unknown>;

describe('tagging mode', () => {
  let t: TestApp;

  const create = async (payload: Props) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { props: '1', ...payload },
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };
  const row = async (id: number) =>
    (await t.db.select().from(garment).where(eq(garment.id, id)))[0];
  const tag = (id: number, payload: Props) =>
    t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/tag`,
      payload,
      headers: { 'hx-request': 'true' },
    });
  const card = (query = '') =>
    t.inject({
      method: 'GET',
      url: `/wardrobe/tag${query}`,
      headers: { 'hx-request': 'true' },
    });

  let ids: Record<'done' | 'bag' | 'heavy' | 'blank' | 'archived', number>;

  beforeAll(async () => {
    t = await createTestApp();
    ids = {
      // Fully tagged: never on a card.
      done: await create({
        name: 'Done tee',
        category: 'tops',
        type: 't-shirt',
        warmth: '2',
        formality: '2',
      }),
      // A bag has no warmth: only its type and formality are asked.
      bag: await create({ name: 'Tote', category: 'bags', type: 'tote' }),
      // Warmth chosen on the form (a 6 oz tee), type still missing.
      heavy: await create({
        name: 'Heavy tee',
        category: 'tops',
        warmth: '3',
        fabricWeight: '6',
      }),
      blank: await create({ name: 'Blank tee', category: 'tops' }),
      archived: await create({ name: 'Old tee', category: 'tops' }),
    };
    await t.inject({
      method: 'POST',
      url: `/wardrobe/${ids.archived}/archive`,
    });
  });

  afterAll(() => t?.cleanup());

  it('prompts on the wardrobe with how many need details', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expectNoRawI18nKeys(res);
    // Tote, Heavy tee, Blank tee; not the tagged or the archived one.
    expect(res.body).toContain('3 garments need details');
    expect(res.body).toContain('href="/wardrobe/tag"');
  });

  it('shows the newest garment that needs details first, as a full page', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/tag' });
    expect(res.statusCode).toBe(200);
    expectNoRawI18nKeys(res);
    expectNativePostForms(res);
    expect(res.body).toContain('Blank tee');
    expect(res.body).toContain('3 left to tag');
    expect(res.body).toContain(`href="/wardrobe/tag?before=${ids.blank}"`);
  });

  it('moves past a garment with Next, leaving it for the next pass', async () => {
    const res = await card(`?before=${ids.blank}`);
    expectFragment(res);
    expect(res.body).toContain('Heavy tee');
    expect(res.body).not.toContain('Blank tee');
  });

  it('asks a bag only what a bag has', async () => {
    const res = await card(`?before=${ids.heavy}`);
    expect(res.body).toContain('Tote');
    expect(res.body).toContain('name="formality"');
    expect(res.body).not.toContain('name="warmth"');
  });

  it('fills a type’s presets into what is unset, and saves at once', async () => {
    const res = await tag(ids.blank, { type: 't-shirt' });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    expect(res.body).toMatch(/name="warmth" value="2"[^>]*checked/);
    expect(await row(ids.blank)).toMatchObject({
      type: 't-shirt',
      warmth: 2,
      formality: 2,
      sleeve: 'short',
    });
  });

  it('never overwrites a warmth the form set (the heavy tee stays warm)', async () => {
    await tag(ids.heavy, { type: 't-shirt' });
    expect(await row(ids.heavy)).toMatchObject({
      type: 't-shirt',
      warmth: 3,
      formality: 2,
      fabricWeight: 203,
    });
  });

  it('replaces a value the user taps', async () => {
    await tag(ids.heavy, { type: 't-shirt', warmth: '4', formality: '3' });
    expect(await row(ids.heavy)).toMatchObject({ warmth: 4, formality: 3 });
  });

  it('moves the first type’s presets when another type is tapped', async () => {
    const id = await create({ name: 'Undecided', category: 'tops' });
    await tag(id, { type: 'tank' });
    expect(await row(id)).toMatchObject({ warmth: 1, sleeve: 'sleeveless' });
    // The card saved the tank's presets; a sweater replaces them.
    await tag(id, { type: 'sweater' });
    expect(await row(id)).toMatchObject({
      type: 'sweater',
      warmth: 4,
      formality: 3,
      sleeve: 'long',
    });
    // A value tapped in between is the user's and stays.
    await tag(id, { type: 'sweater', warmth: '5' });
    await tag(id, { type: 'cardigan' });
    expect(await row(id)).toMatchObject({ warmth: 5, sleeve: 'long' });
    await t.inject({ method: 'POST', url: `/wardrobe/${id}/archive` });
  });

  it('ignores a warmth posted for a bag', async () => {
    await tag(ids.bag, { warmth: '3', formality: '2' });
    expect(await row(ids.bag)).toMatchObject({ warmth: null, formality: 2 });
  });

  it('refuses a type the category does not have', async () => {
    const res = await tag(ids.bag, { type: 't-shirt' });
    expect(res.statusCode).toBe(400);
    expect((await row(ids.bag)).type).toBe('tote');
  });

  it('logs the tap', async () => {
    await tag(ids.blank, { formality: '3' });
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      expect.stringMatching(
        new RegExp(`^Garment ${ids.blank} tagged by user \\d+: formality$`),
      ),
    );
  });

  it('says so when every garment is tagged, and the prompt goes', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/tag' });
    expectNoRawI18nKeys(res);
    expect(res.body).toContain('Every garment has its details.');
    const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(wardrobe.body).not.toContain('need details');
  });
});
