import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Garment } from '../../src/dal/entity/garment.entity';
import { User } from '../../src/dal/entity/user.entity';
import { variantFileName } from '../../src/web/files/image-variant';
import { jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, TestApp } from './harness';

/**
 * The garment edit, clone and archive paths: the forms render the stored
 * values, POST /wardrobe/:id writes them, a clone lands in the requester's
 * wardrobe with its own copy of the photo set, and archive toggles. Alice owns the garments; Bob holds a MANAGE share on her
 * wardrobe; Carol has no share.
 */

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Every field the garment form (views/wardrobe/form.hbs) posts. */
const FORM = {
  name: 'Black Linen Blazer',
  category: 'jacket',
  brand: 'Uniqlo',
  color: ['black', 'white'],
  size: 'm',
  washingDetails: 'Dry clean only',
  dateAquired: '2024-03-15',
  notes: 'Summer weddings',
};

describe('garment edit, clone and archive', () => {
  let t: TestApp;
  let alice: { id: number; cookie: string };
  let bob: { id: number; cookie: string };
  let carol: { cookie: string };
  let garmentId: number;

  const userId = async (email: string) =>
    (await t.em().findOneOrFail(User, { email })).id;

  const load = (id: number) =>
    t.em().findOneOrFail(Garment, id, { populate: ['photo', 'owner'] });

  const post = (
    url: string,
    payload: Record<string, unknown>,
    cookie: string,
  ) => t.inject({ method: 'POST', url, payload, headers: { cookie } });

  const get = (url: string, cookie: string) =>
    t.inject({ method: 'GET', url, headers: { cookie } });

  const idFromRedirect = (location: unknown) => {
    const match = /^\/wardrobe\/(\d+)/.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect: ${String(location)}`);
    return Number(match[1]);
  };

  /** Alice's garment with every field set and a photo. */
  const createFullGarment = async (overrides: Partial<typeof FORM> = {}) => {
    const res = await post(
      '/wardrobe',
      { ...FORM, ...overrides },
      alice.cookie,
    );
    expect(res.statusCode).toBe(302);
    const id = idFromRedirect(res.headers.location);
    await uploadPhoto(t, id, await jpegPhoto(), alice.cookie);
    return id;
  };

  const photoFiles = (fileName: string) =>
    (['original', 'thumb'] as const).map((variant) =>
      join(t.dataPath, variantFileName(fileName, variant)),
    );

  beforeAll(async () => {
    t = await createTestApp();
    alice = {
      cookie: await t.register('alice@example.com'),
      id: await userId('alice@example.com'),
    };
    bob = {
      cookie: await t.register('bob@example.com'),
      id: await userId('bob@example.com'),
    };
    carol = { cookie: await t.register('carol@example.com') };

    // Alice shares her wardrobe with Bob (MANAGE), as the manage page does.
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'MANAGE' },
      headers: { cookie: alice.cookie, 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )?.[1];
    if (!token) throw new Error(`No invite URL in partial:\n${invite.body}`);
    const accepted = await post(
      `/wardrobe-share/invite/${token}/accept`,
      {},
      bob.cookie,
    );
    expect(accepted.headers.location).toBe('/wardrobe-share/manage');

    garmentId = await createFullGarment();
  });

  afterAll(() => t?.cleanup());

  describe('GET /wardrobe/:id/edit', () => {
    it('renders the stored values into the form', async () => {
      const res = await get(`/wardrobe/${garmentId}/edit`, alice.cookie);
      expect(res.statusCode).toBe(200);
      const html = res.body;
      expect(html).toContain(`action="/wardrobe/${garmentId}"`);
      expect(html).toContain('value="Black Linen Blazer"');
      expect(html).toContain('value="jacket"');
      expect(html).toContain('value="Uniqlo"');
      // Stored normalised: "m" -> "Medium".
      expect(html).toContain('value="Medium"');
      expect(html).toContain('value="2024-03-15"');
      expect(html).toMatch(/name="washingDetails"[^>]*>\s*Dry clean only/);
      expect(html).toMatch(/name="notes"[^>]*>\s*Summer weddings/);
      for (const color of ['black', 'white']) {
        expect(html).toMatch(
          new RegExp(`name="color" value="${color}"\\s+checked`),
        );
      }
      expect(html).not.toMatch(/name="color" value="red"\s+checked/);
    });

    // Not in any wardrobe carol can see: as unknown as a missing id.
    it('does not exist for a user without a share', async () => {
      const res = await get(`/wardrobe/${garmentId}/edit`, carol.cookie);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /wardrobe/:id', () => {
    it('writes every field and redirects to the garment', async () => {
      const id = await createFullGarment();
      const res = await post(
        `/wardrobe/${id}`,
        {
          name: 'Navy Linen Blazer',
          category: 'coat',
          brand: '',
          color: ['blue'],
          size: 'xl',
          washingDetails: 'Hand wash cold',
          dateAquired: '2025-01-02',
          notes: 'Tailored in May',
        },
        alice.cookie,
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/wardrobe/${id}`);

      const garment = await load(id);
      expect(garment).toMatchObject({
        name: 'Navy Linen Blazer',
        category: 'coat',
        brand: '',
        color: 'blue',
        size: 'X-Large',
        washingDetails: 'Hand wash cold',
        notes: 'Tailored in May',
        archived: false,
      });
      expect(garment.acquiredOn).toBe('2025-01-02');
      expect(garment.owner.id).toBe(alice.id);
      // The fields-only form never touches the photo.
      expect(garment.photo).toBeDefined();
    });

    it('a MANAGE grantee edits through ?ownerId and is sent back there', async () => {
      const id = await createFullGarment();
      const res = await post(
        `/wardrobe/${id}?ownerId=${alice.id}`,
        { ...FORM, name: 'Edited by Bob' },
        bob.cookie,
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/wardrobe/${id}?ownerId=${alice.id}`);
      const garment = await load(id);
      expect(garment.name).toBe('Edited by Bob');
      expect(garment.owner.id).toBe(alice.id);
    });

    it('a user without a share cannot edit', async () => {
      const res = await post(
        `/wardrobe/${garmentId}`,
        { ...FORM, name: 'Hijacked' },
        carol.cookie,
      );
      expect(res.statusCode).toBe(404);
      expect((await load(garmentId)).name).toBe(FORM.name);
    });

    // New bug: POST /wardrobe/:id has no server-side validation. Category is
    // required (entity non-nullable, `required` in the form) but an empty
    // string is stored, and the garment drops out of every category filter.
    it.fails(
      'an empty category is rejected and the row is unchanged',
      async () => {
        const id = await createFullGarment();
        const res = await post(
          `/wardrobe/${id}`,
          { ...FORM, category: '' },
          alice.cookie,
        );
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain(`action="/wardrobe/${id}"`);
        expect((await load(id)).category).toBe(FORM.category);
      },
    );

    // New bug: an unparseable dateAquired becomes `new Date('…')` (Invalid
    // Date) and reaches Postgres, which rejects it: 500 instead of a
    // re-rendered form.
    it.fails(
      'an invalid date is rejected with 400 and the row is unchanged',
      async () => {
        const id = await createFullGarment();
        const res = await post(
          `/wardrobe/${id}`,
          { ...FORM, dateAquired: 'not-a-date' },
          alice.cookie,
        );
        expect(res.statusCode).toBe(400);
        expect((await load(id)).acquiredOn).toBe(FORM.dateAquired);
      },
    );

    // Notes were varchar(255) until drizzle/0004_garment_web.sql: longer
    // ones were a 500.
    it('keeps notes longer than 255 characters', async () => {
      const id = await createFullGarment();
      const notes = 'Long care history. '.repeat(30);
      const res = await post(
        `/wardrobe/${id}`,
        { ...FORM, notes },
        alice.cookie,
      );
      expect(res.statusCode).toBe(302);
      expect((await load(id)).notes).toBe(notes);
    });

    it('keyword search finds a garment in its stored case', async () => {
      const res = await get('/wardrobe?keyword=Linen', alice.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Black Linen Blazer');
    });

    // Known bug (docs/audits/2026-09-25-program2): keyword search is case-sensitive on Postgres (LIKE, not ILIKE).
    it.fails('keyword search ignores case', async () => {
      const res = await get('/wardrobe?keyword=blazer', alice.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Black Linen Blazer');
    });
  });

  describe('clone', () => {
    it('GET /wardrobe/:id/clone prefills the form from the source', async () => {
      const res = await get(
        `/wardrobe/${garmentId}/clone?ownerId=${alice.id}`,
        bob.cookie,
      );
      expect(res.statusCode).toBe(200);
      const html = res.body;
      expect(html).toContain(
        `action="/wardrobe/${garmentId}/clone?ownerId=${alice.id}"`,
      );
      expect(html).toContain('value="Black Linen Blazer (cloned)"');
      expect(html).toContain('value="jacket"');
      expect(html).toContain('value="Uniqlo"');
      expect(html).toContain('value="2024-03-15"');
      expect(html).toMatch(/name="washingDetails"[^>]*>\s*Dry clean only/);
    });

    it('POST creates the requester’s own garment with a copied photo set', async () => {
      const source = await load(garmentId);
      const res = await post(
        `/wardrobe/${garmentId}/clone?ownerId=${alice.id}`,
        { ...FORM, name: 'Black Linen Blazer (cloned)' },
        bob.cookie,
      );
      expect(res.statusCode).toBe(302);
      const cloneId = idFromRedirect(res.headers.location);
      expect(cloneId).not.toBe(garmentId);

      const clone = await load(cloneId);
      expect(clone.owner.id).toBe(bob.id);
      expect(clone).toMatchObject({
        name: 'Black Linen Blazer (cloned)',
        category: source.category,
        brand: source.brand,
        color: source.color,
        size: source.size,
        notes: source.notes,
        archived: false,
      });
      expect(clone.shareableId).not.toBe(source.shareableId);

      // Its own photo set: a new File row and new bytes, owned by Bob, while
      // the source's files stay where they were.
      expect(clone.photo).toBeDefined();
      expect(clone.photo!.fileName).not.toBe(source.photo!.fileName);
      expect(clone.photo!.createdBy.id).toBe(bob.id);
      for (const path of photoFiles(clone.photo!.fileName)) {
        expect(await exists(path)).toBe(true);
      }
      for (const path of photoFiles(source.photo!.fileName)) {
        expect(await exists(path)).toBe(true);
      }

      // It shows in Bob's own wardrobe, not Alice's.
      const own = await get('/wardrobe?keyword=cloned', bob.cookie);
      expect(own.body).toContain(`/wardrobe/${cloneId}"`);
    });

    // Known bug (docs/audits/2026-09-25-program2): cloning a garment drops washingDetails and dateAquired.
    it.fails('POST keeps washingDetails and dateAquired', async () => {
      const res = await post(
        `/wardrobe/${garmentId}/clone`,
        { ...FORM, name: 'Second copy' },
        alice.cookie,
      );
      expect(res.statusCode).toBe(302);
      const clone = await load(idFromRedirect(res.headers.location));
      expect(clone.washingDetails).toBe(FORM.washingDetails);
      expect(clone.acquiredOn).toBe(FORM.dateAquired);
    });

    it('a user without a share cannot clone', async () => {
      const before = await t.em().count(Garment);
      const res = await post(
        `/wardrobe/${garmentId}/clone?ownerId=${alice.id}`,
        FORM,
        carol.cookie,
      );
      expect(res.statusCode).toBe(404);
      expect(await t.em().count(Garment)).toBe(before);
    });
  });

  describe('POST /wardrobe/:id/archive', () => {
    it('toggles archived and the list follows', async () => {
      const id = await createFullGarment({ name: 'Archive me' });
      const listed = async (query: string) =>
        (await get(`/wardrobe?${query}`, alice.cookie)).body.includes(
          `/wardrobe/${id}"`,
        );

      const archive = await post(`/wardrobe/${id}/archive`, {}, alice.cookie);
      expect(archive.statusCode).toBeLessThan(300);
      expect(archive.headers['hx-redirect']).toBe('/wardrobe');
      expect((await load(id)).archived).toBe(true);
      expect(await listed('keyword=Archive')).toBe(false);
      expect(await listed('keyword=Archive&archived=true')).toBe(true);

      await post(`/wardrobe/${id}/archive`, {}, alice.cookie);
      expect((await load(id)).archived).toBe(false);
      expect(await listed('keyword=Archive')).toBe(true);
    });

    it('only the owner may archive', async () => {
      const res = await post(
        `/wardrobe/${garmentId}/archive?ownerId=${alice.id}`,
        {},
        bob.cookie,
      );
      expect(res.statusCode).toBe(403);
      expect((await load(garmentId)).archived).toBe(false);
    });
  });
});
