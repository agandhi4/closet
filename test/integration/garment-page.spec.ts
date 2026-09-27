import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GARMENT_OUTFITS_SHOWN } from '../../src/web/outfits/garment-outfits';
import { createGarment } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectFragment, expectFullPage } from './pages';

/**
 * The garment page (#84, redesign plan "Garment page"): the facts line, the
 * wear line with its cost per wear and the primary actions (Style this,
 * Wore today, Washed), the ⋯ menu with what the requester may do, the photo
 * sheet, and "In N outfits", the owner's alone like outfits.
 */

const form = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
};

/** The markup between an element's opening tag with `id` and its `</tag>`. */
function sectionOf(html: string, id: string, tag = 'section'): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start, `#${id}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(`</${tag}>`, start));
}

describe('the garment page', () => {
  let t: TestApp;
  let ownerId: number;
  let boots: number;
  let viewer: string;

  const page = async (id: number, cookie?: string, query = '') => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${id}${query}`,
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
    return unescapeHtml(res.body);
  };

  const newOutfit = async (name: string, garmentIds: number[]) => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...form({
        name,
        category: garmentIds.map(() => 'footwear'),
        garmentId: garmentIds.map(String),
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    const created = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({
        name: 'Iron Rangers',
        category: 'footwear',
        brand: 'Red Wing',
        size: '9',
        product: '1',
        price: '350',
        care: '1',
        quantity: '1',
        condition: 'good',
      }),
    });
    expect(created.statusCode).toBe(302);
    boots = Number(
      /^\/wardrobe\/(\d+)/.exec(String(created.headers.location))![1],
    );

    viewer = await t.register('viewer@example.com');
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    const accepted = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      payload: {},
      headers: { cookie: viewer },
    });
    expect(accepted.statusCode).toBeLessThan(400);
  });

  afterAll(() => t?.cleanup());

  it('leads with the facts line, then the wear line and the primary actions', async () => {
    const html = await page(boots);
    expect(html).toMatch(
      /Red Wing · <span class="capitalize">[^<]+<\/span> · 9/,
    );
    const wear = sectionOf(html, 'garment-wear');
    expect(wear).toContain('Not worn yet');
    expect(wear).toContain(`href="/styling?with=${boots}"`);
    expect(wear).toContain(`action="/wardrobe/${boots}/wear"`);
    // The facts come before the wear line, which comes before the details.
    expect(html.indexOf('Red Wing')).toBeLessThan(html.indexOf('Not worn yet'));
    expect(html.indexOf('Not worn yet')).toBeLessThan(
      html.indexOf('garment-details-title'),
    );
  });

  it('says what a wear cost, and Wore today answers the line with Style this', async () => {
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${boots}/wear`,
      ...form({ worn: '1' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'hx-request': 'true',
      },
    });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    const status = unescapeHtml(res.body);
    expect(status).toContain('id="garment-wear-status"');
    expect(status).toContain('Worn once');
    expect(status).toContain('$350.00 a wear');
    expect(status).toContain(`href="/styling?with=${boots}"`);
    // Undo the wear, so the next specs start clean.
    await t.inject({
      method: 'POST',
      url: `/wardrobe/${boots}/wear`,
      ...form({ worn: '0' }),
    });
  });

  it('puts edit, the photo sheet, clone, share, archive and delete in the ⋯ menu', async () => {
    const html = await page(boots);
    const menu = sectionOf(html, 'garment-menu', 'details');
    expect(menu).toContain(`href="/wardrobe/${boots}/edit"`);
    expect(menu).toContain("getElementById('garment-photo-sheet')");
    expect(menu).toContain(`href="/wardrobe/${boots}/clone"`);
    expect(menu).toContain('data-copy=');
    expect(menu).toContain(`hx-post="/wardrobe/${boots}/archive"`);
    expect(menu).toContain(`hx-delete="/wardrobe/${boots}"`);
    // The menu is the app bar's; the page body holds no upload controls.
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    expect(main).not.toContain('name="photo"');
  });

  it('takes the photo in a sheet: the camera and the library, each its own upload', async () => {
    const html = await page(boots);
    const sheet = sectionOf(html, 'garment-photo-sheet', 'dialog');
    // Native multipart posts, so a refused photo is shown (htmx drops a 4xx).
    const forms = sheet.match(/<form method="post"[^>]*>/g) ?? [];
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      expect(form).toContain(
        `method="post" action="/wardrobe/${boots}/photo" enctype="multipart/form-data"`,
      );
      expect(form).toContain('data-needs-network=""');
      expect(form).not.toContain('hx-post');
    }
    expect(sheet).toMatch(
      /id="photoCaptureInput" name="photo"[^>]*capture="environment"/,
    );
    expect(sheet).toMatch(/id="photoInput" name="photo"/);
    expect(sheet).not.toMatch(/id="photoInput"[^>]*capture=/);
    // No photo yet: the hero offers the sheet too.
    expect(sectionOf(html, 'garment-photo', 'div')).toContain(
      "getElementById('garment-photo-sheet')",
    );
  });

  it('shows the owner the outfits it is in, newest first, as many as the strip holds', async () => {
    expect(await page(boots)).not.toContain('id="garment-outfits"');

    const other = await createGarment(t, {
      name: 'Selvedge jeans',
      category: 'bottoms',
    });
    await newOutfit('Other outfit', [other]);
    const ids: number[] = [];
    for (let i = 1; i <= GARMENT_OUTFITS_SHOWN + 1; i++) {
      ids.push(await newOutfit(`Boots ${i}`, [boots, other]));
    }
    const html = await page(boots);
    const strip = sectionOf(html, 'garment-outfits');
    expect(strip).toContain(`In ${GARMENT_OUTFITS_SHOWN + 1} outfits`);
    const shown = [...strip.matchAll(/data-garment-outfit="(\d+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(shown).toEqual(ids.slice(1).reverse());
    expect(strip).not.toContain('Other outfit');

    // One more statement for the count and one for the strip, whatever the
    // number of outfits.
    const { sql } = await recordQueries(() => page(boots));
    const outfitReads = sql.filter((text) => text.includes('"outfit_slot"'));
    expect(outfitReads).toHaveLength(2);
  });

  it('shows a grantee Style this in their view, and neither wears nor outfits', async () => {
    const html = await page(boots, viewer, `?ownerId=${ownerId}`);
    expect(html).toContain(`href="/styling?with=${boots}&ownerId=${ownerId}"`);
    expect(html).not.toContain('id="garment-wear"');
    expect(html).not.toContain('id="garment-outfits"');
    expect(html).not.toContain('id="garment-away"');
    const menu = sectionOf(html, 'garment-menu', 'details');
    expect(menu).toContain(
      `href="/wardrobe/${boots}/clone?ownerId=${ownerId}"`,
    );
    expect(menu).not.toContain('/edit');
    expect(menu).not.toContain('garment-photo-sheet');
    expect(menu).not.toContain('hx-delete');
    expect(html).not.toContain('id="garment-photo-sheet"');
  });
});
