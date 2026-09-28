import { randomUUID } from 'node:crypto';
import { readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  file,
  garment,
  pendingPhoto,
  wardrobeShare,
} from '../../src/db/schema';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  DRAFT_LIFETIME_MS,
  MAX_DRAFTS_PER_USER,
  MAX_PENDING_PER_USER,
} from '../../src/web/files/pending-photos';
import { t as text } from '../../src/web/i18n';
import { readGarmentForm } from '../../src/web/wardrobe/validation';
import { createGarmentWithPendingPhoto } from '../../src/web/wardrobe/writes';
import { jpegPhoto } from './garments';
import {
  createTestApp,
  type MultipartFile,
  multipart,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { silentLogger } from './logger';
import { expectNativePostForms, expectNoRawI18nKeys } from './pages';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Adding several garments from photos at once (#200;
 * docs/plans/2026-09-28-multi-add-and-export.md): a library pick of two or
 * more is a batch of drafts (pending photos with a batch), opened one by
 * one on the new garment form; each save claims its draft and moves on,
 * and the last lands in select mode with the batch checked. Drafts are
 * never evicted: past MAX_DRAFTS_PER_USER an upload is refused whole.
 */

describe('a batch of drafts', () => {
  let t: TestApp;
  let photoBytes: Buffer;

  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    return { cookie, id: await userIdOf(t, email) };
  };

  const jpeg = (name: string, data = photoBytes): MultipartFile => ({
    data,
    filename: name,
    contentType: 'image/jpeg',
  });
  const photos = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      jpeg(`IMG_${String(index + 1).padStart(4, '0')}.jpg`),
    );

  /** POST /wardrobe/new/photo with `files` as its `photo` parts. */
  const upload = async (
    files: MultipartFile[],
    { cookie, ownerId }: { cookie: string; ownerId?: number },
  ) => {
    const body = await multipart({}, { photo: files });
    return t.inject({
      method: 'POST',
      url: `/wardrobe/new/photo${ownerId ? `?ownerId=${ownerId}` : ''}`,
      payload: body.payload,
      headers: { ...body.headers, cookie },
    });
  };

  const location = (res: { headers: Record<string, unknown> }) =>
    new URL(String(res.headers.location), 'http://localhost');

  const draftsOf = (userId: number) =>
    t.db
      .select()
      .from(pendingPhoto)
      .where(
        and(eq(pendingPhoto.userId, userId), isNotNull(pendingPhoto.batchId)),
      )
      .orderBy(pendingPhoto.batchPosition);
  const unbatchedOf = async (userId: number) =>
    (
      await t.db
        .select({ fileName: pendingPhoto.fileName })
        .from(pendingPhoto)
        .where(
          and(eq(pendingPhoto.userId, userId), isNull(pendingPhoto.batchId)),
        )
    ).map((row) => row.fileName);
  const storedOriginals = async () =>
    (await readdir(t.dataPath)).filter((name) =>
      /^[0-9a-f-]{36}\.webp$/.test(name),
    );

  const page = (url: string, cookie: string) =>
    t.inject({ method: 'GET', url, headers: { cookie } });
  const savedIn = (body: string) =>
    /name="draftsSaved" value="([^"]*)"/.exec(body)?.[1];

  beforeAll(async () => {
    t = await createTestApp();
    photoBytes = await jpegPhoto(300, 400);
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(() => t?.cleanup());

  it('offers the library as a multiple pick, the camera as one photo', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    const sheet = unescapeHtml(res.body).slice(
      res.body.indexOf('id="add-sheet"'),
    );
    expect(sheet).toMatch(/form="add-photo-library"[^>]*\smultiple/);
    expect(sheet).not.toMatch(/form="add-photo-camera"[^>]*\smultiple/);
  });

  it('turns fifteen photos into fifteen drafts, evicts none, and steps through every one to select mode', async () => {
    const { cookie, id } = await signUp('fifteen@example.com');
    // A full set of single pending photos first: the batch must not evict
    // them, nor they the batch.
    for (let index = 0; index < MAX_PENDING_PER_USER; index += 1) {
      expect((await upload([jpeg('one.jpg')], { cookie })).statusCode).toBe(
        303,
      );
    }
    const singles = await unbatchedOf(id);
    expect(singles).toHaveLength(MAX_PENDING_PER_USER);
    const garments = await t.db.$count(garment);
    const files = await t.db.$count(file);

    const res = await upload(photos(15), { cookie });
    expect(res.statusCode).toBe(303);
    const drafts = await draftsOf(id);
    expect(drafts).toHaveLength(15);
    expect(new Set(drafts.map((draft) => draft.batchId)).size).toBe(1);
    expect(drafts.map((draft) => draft.batchPosition)).toEqual(
      Array.from({ length: 15 }, (_, index) => index),
    );
    expect(drafts.every((draft) => draft.batchOwnerId === id)).toBe(true);
    expect(await unbatchedOf(id)).toEqual(expect.arrayContaining(singles));
    // Nothing reaches garment or file until a draft is saved.
    expect(await t.db.$count(garment)).toBe(garments);
    expect(await t.db.$count(file)).toBe(files);
    const first = location(res);
    expect(first.pathname).toBe('/wardrobe/new');
    expect(first.searchParams.get('photo')).toBe(drafts[0]?.fileName);

    // Another single upload evicts a single, never a draft.
    await upload([jpeg('later.jpg')], { cookie });
    expect(await draftsOf(id)).toHaveLength(15);
    expect(await unbatchedOf(id)).toHaveLength(MAX_PENDING_PER_USER);

    // The grid offers to continue them.
    const grid = unescapeHtml((await page('/wardrobe', cookie)).body);
    expect(grid).toContain(text('drafts.WAITING', { count: 15 }));
    expect(grid).toContain(`href="/wardrobe/new?photo=${drafts[0]?.fileName}"`);

    // The first draft: its queue, the category before the name, and the
    // duplicate check (#20).
    const form = await page(first.pathname + first.search, cookie);
    expect(form.statusCode).toBe(200);
    const html = unescapeHtml(form.body);
    expect(html).toContain(text('drafts.QUEUE_TITLE', { count: 15 }));
    expect(html.match(/src="\/file\/thumb\/[^"]+"/g)?.length).toBe(16);
    expect(html.indexOf('name="category"')).toBeLessThan(
      html.indexOf('name="name"'),
    );
    expect(html).toContain('id="garment-lookalikes"');
    expect(savedIn(html)).toBe('');
    expectNativePostForms(form);
    expectNoRawI18nKeys(form);

    // Save each in turn: every save lands on the next draft, the last on
    // select mode with all fifteen checked.
    let url = first.pathname + first.search;
    const saved: number[] = [];
    for (let index = 0; index < 15; index += 1) {
      const current = new URL(url, 'http://localhost');
      const photo = current.searchParams.get('photo')!;
      expect(photo).toBe(drafts[index]?.fileName);
      const draftPage = await page(url, cookie);
      const saveRes = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        headers: { cookie },
        payload: {
          category: 'tops',
          name: `Batch shirt ${index + 1}`,
          linkPhoto: photo,
          draftsSaved: savedIn(unescapeHtml(draftPage.body)) ?? '',
        },
      });
      expect(saveRes.statusCode).toBe(303);
      const [row] = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(eq(garment.name, `Batch shirt ${index + 1}`));
      saved.push(row.id);
      const next = location(saveRes);
      url = next.pathname + next.search;
      if (index < 14) {
        expect(next.pathname).toBe('/wardrobe/new');
        expect(next.searchParams.get('saved')).toBe(saved.join(','));
      }
    }
    const done = new URL(url, 'http://localhost');
    expect(done.pathname).toBe('/wardrobe');
    expect(done.searchParams.get('select')).toBe('1');
    expect(done.searchParams.get('checked')).toBe(saved.join(','));

    // Fifteen garments, each with its own draft's photo; no draft left.
    const rows = await t.db
      .select({ fileName: file.fileName })
      .from(garment)
      .innerJoin(file, eq(file.id, garment.photoId))
      .where(inArray(garment.id, saved));
    expect(rows.map((row) => row.fileName).sort()).toEqual(
      drafts.map((draft) => draft.fileName).sort(),
    );
    expect(await draftsOf(id)).toEqual([]);
    expect(t.logs.messages('info', 'Web')).toContain(
      'Draft queue done: 15 garments saved',
    );

    // Select mode: the batch checked, so "Set…" tags it together.
    const select = await page(url, cookie);
    const selectHtml = unescapeHtml(select.body);
    expect(selectHtml).toContain(text('drafts.DONE', { count: 15 }));
    for (const garmentId of saved) {
      expect(selectHtml).toMatch(
        new RegExp(`name="ids" value="${garmentId}" checked=""`),
      );
    }
    expect(selectHtml).toMatch(/id="selected-count"[^>]*>15</);
    expect(selectHtml).not.toContain(text('drafts.WAITING', { count: 15 }));
    expectNativePostForms(select);
  });

  it('skips, discards and wraps round, and a refused save keeps the queue', async () => {
    const { cookie, id } = await signUp('queue@example.com');
    const res = await upload(photos(3), { cookie });
    const [a, b, c] = (await draftsOf(id)).map((draft) => draft.fileName) as [
      string,
      string,
      string,
    ];

    // On a: Skip goes to b.
    const onA = unescapeHtml(
      (await page(location(res).pathname + location(res).search, cookie)).body,
    );
    expect(onA).toMatch(
      new RegExp(`href="/wardrobe/new\\?photo=${b}"[^>]*data-draft-skip`),
    );

    // On b: Discard drops it (bytes too) and goes to c, the next after it.
    const discard = await t.inject({
      method: 'POST',
      url: '/wardrobe/new/drafts/discard',
      headers: { cookie },
      payload: { photo: b, saved: '' },
    });
    expect(discard.statusCode).toBe(303);
    expect(location(discard).searchParams.get('photo')).toBe(c);
    expect(await storedOriginals()).not.toContain(b);

    // On c: a refused save keeps the queue, then a real one goes back to
    // a, the one skipped.
    const refused = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      headers: { cookie },
      payload: { category: '', linkPhoto: c, draftsSaved: '' },
    });
    expect(refused.statusCode).toBe(400);
    expect(unescapeHtml(refused.body)).toContain(
      text('drafts.QUEUE_TITLE', { count: 2 }),
    );
    const saveC = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      headers: { cookie },
      payload: { category: 'tops', linkPhoto: c, draftsSaved: '' },
    });
    const toA = location(saveC);
    expect(toA.searchParams.get('photo')).toBe(a);
    const savedC = toA.searchParams.get('saved')!;
    expect(savedC).toMatch(/^\d+$/);

    // On a, the last: no Skip, and its save ends the queue.
    const lastHtml = unescapeHtml(
      (await page(toA.pathname + toA.search, cookie)).body,
    );
    expect(lastHtml).toContain(text('drafts.QUEUE_TITLE_ONE'));
    expect(lastHtml).not.toContain('data-draft-skip');
    const saveA = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      headers: { cookie },
      payload: { category: 'tops', linkPhoto: a, draftsSaved: savedC },
    });
    expect(location(saveA).searchParams.get('checked')).toMatch(
      new RegExp(`^${savedC},\\d+$`),
    );

    // A second tap on a discarded draft discards nothing and ends the queue.
    const again = await t.inject({
      method: 'POST',
      url: '/wardrobe/new/drafts/discard',
      headers: { cookie },
      payload: { photo: b, saved: '' },
    });
    expect(location(again).pathname).toBe('/wardrobe');
    expect(await draftsOf(id)).toEqual([]);
  });

  it('leaves out and names a photo it cannot read, keeping the others', async () => {
    const { cookie, id } = await signUp('unreadable@example.com');
    const res = await upload(
      [
        jpeg('good-1.jpg'),
        {
          data: Buffer.from('not a jpeg at all'),
          filename: 'broken.jpg',
          contentType: 'image/jpeg',
        },
        jpeg('good-2.jpg'),
      ],
      { cookie },
    );
    expect(res.statusCode).toBe(303);
    expect(await draftsOf(id)).toHaveLength(2);
    expect(location(res).searchParams.getAll('leftOut')).toEqual([
      'broken.jpg',
    ]);
    const html = unescapeHtml(
      (await page(location(res).pathname + location(res).search, cookie)).body,
    );
    expect(html).toContain(text('drafts.LEFT_OUT', { names: 'broken.jpg' }));

    // None readable: the error page, nothing kept.
    const originals = await storedOriginals();
    const none = await upload(
      [
        {
          data: Buffer.from('a'),
          filename: 'a.jpg',
          contentType: 'image/jpeg',
        },
        {
          data: Buffer.from('b'),
          filename: 'b.jpg',
          contentType: 'image/jpeg',
        },
      ],
      { cookie },
    );
    expect(none.statusCode).toBe(400);
    expect(unescapeHtml(none.body)).toContain(text('drafts.NONE_READ'));
    expect(await storedOriginals()).toEqual(originals);
  });

  it('waits a week for its drafts where a single pending photo waits a day', async () => {
    expect(DRAFT_LIFETIME_MS).toBe(7 * DAY_MS);
    const { cookie, id } = await signUp('slow-batch@example.com');
    await upload(photos(3), { cookie });
    const [young, old, older] = (await draftsOf(id)).map(
      (draft) => draft.fileName,
    ) as [string, string, string];
    const single = location(
      await upload([jpeg('single.jpg')], { cookie }),
    ).searchParams.get('photo')!;
    const age = async (name: string, days: number) => {
      const when = new Date(Date.now() - days * DAY_MS);
      await t.db
        .update(pendingPhoto)
        .set({ createdAt: when })
        .where(eq(pendingPhoto.fileName, name));
      for (const variant of ['original', 'thumb'] as const) {
        await utimes(
          join(t.dataPath, variantFileName(name, variant)),
          when,
          when,
        );
      }
    };
    // Two days: past a single photo's day, well inside a draft's week.
    await age(young, 2);
    await age(single, 2);
    // Six days and a half, then eight: either side of the week.
    await age(old, 6.5);
    await age(older, 8);

    const reconcile = (dryRun: boolean) =>
      reconcileStorage(
        { db: t.db, photos: t.photos, logger: silentLogger },
        { dryRun },
      );
    // The dry run applies the same rule as the real one.
    expect((await reconcile(true)).pendingPhotosDeleted).toBe(2);
    const report = await reconcile(false);
    expect(report.refused).toBeUndefined();
    expect(report.pendingPhotosDeleted).toBe(2);
    expect((await draftsOf(id)).map((draft) => draft.fileName)).toEqual([
      young,
      old,
    ]);
    expect(await unbatchedOf(id)).toEqual([]);
    const stored = await storedOriginals();
    expect(stored).toEqual(expect.arrayContaining([young, old]));
    expect(stored).not.toContain(older);
    expect(stored).not.toContain(single);

    // The queue says how long they wait.
    const html = unescapeHtml(
      (await page(`/wardrobe/new?photo=${young}`, cookie)).body,
    );
    expect(html).toContain(text('drafts.QUEUE_HINT'));
    expect(text('drafts.QUEUE_HINT')).toContain('a week');
  });

  it(`refuses a batch past ${MAX_DRAFTS_PER_USER} drafts whole, keeping nothing, and still takes one photo`, async () => {
    const { cookie, id } = await signUp('full@example.com');
    expect((await upload(photos(15), { cookie })).statusCode).toBe(303);
    expect((await upload(photos(13), { cookie })).statusCode).toBe(303);
    expect(await draftsOf(id)).toHaveLength(28);

    // Three would pass 30: the parser stops at the third.
    const before = await storedOriginals();
    const over = await upload(photos(3), { cookie });
    expect(over.statusCode).toBe(409);
    expect(unescapeHtml(over.body)).toContain(
      text('drafts.FULL', { held: 28, max: MAX_DRAFTS_PER_USER }),
    );
    expect(await storedOriginals()).toEqual(before);
    expect(await draftsOf(id)).toHaveLength(28);

    // Two fit exactly.
    expect((await upload(photos(2), { cookie })).statusCode).toBe(303);
    expect(await draftsOf(id)).toHaveLength(MAX_DRAFTS_PER_USER);

    // Full: another batch is refused before a byte is kept, but one photo
    // is not a draft and still goes through.
    expect((await upload(photos(2), { cookie })).statusCode).toBe(409);
    const one = await upload([jpeg('single.jpg')], { cookie });
    expect(one.statusCode).toBe(303);
    expect(await unbatchedOf(id)).toEqual([
      location(one).searchParams.get('photo'),
    ]);
    expect(await draftsOf(id)).toHaveLength(MAX_DRAFTS_PER_USER);
  });

  it("keeps a grantee's drafts with the wardrobe they add to", async () => {
    const owner = await signUp('batch-owner@example.com');
    const manager = await signUp('batch-manager@example.com');
    await t.db.insert(wardrobeShare).values({
      grantorId: owner.id,
      granteeId: manager.id,
      permission: 'MANAGE',
      inviteToken: randomUUID(),
      createdAt: new Date(),
      acceptedAt: new Date(),
    });

    const res = await upload(photos(2), {
      cookie: manager.cookie,
      ownerId: owner.id,
    });
    expect(res.statusCode).toBe(303);
    expect(location(res).searchParams.get('ownerId')).toBe(String(owner.id));
    const drafts = await draftsOf(manager.id);
    expect(drafts.map((draft) => draft.batchOwnerId)).toEqual([
      owner.id,
      owner.id,
    ]);

    const waiting = text('drafts.WAITING', { count: 2 });
    // The manager sees them on the owner's wardrobe, not their own; the
    // owner never sees the manager's drafts.
    expect(
      unescapeHtml(
        (await page(`/wardrobe?ownerId=${owner.id}`, manager.cookie)).body,
      ),
    ).toContain(waiting);
    expect(
      unescapeHtml((await page('/wardrobe', manager.cookie)).body),
    ).not.toContain(waiting);
    expect(
      unescapeHtml((await page('/wardrobe', owner.cookie)).body),
    ).not.toContain(waiting);

    // Saving one lands in the owner's wardrobe and the queue stays there.
    const save = await t.inject({
      method: 'POST',
      url: `/wardrobe?ownerId=${owner.id}`,
      headers: { cookie: manager.cookie },
      payload: { category: 'tops', linkPhoto: drafts[0].fileName },
    });
    expect(location(save).searchParams.get('ownerId')).toBe(String(owner.id));
    expect(location(save).searchParams.get('photo')).toBe(drafts[1].fileName);
    const [row] = await t.db
      .select({ ownerId: garment.ownerId })
      .from(garment)
      .innerJoin(file, eq(file.id, garment.photoId))
      .where(eq(file.fileName, drafts[0].fileName));
    expect(row?.ownerId).toBe(owner.id);
  });
  it("never saves or discards one wardrobe's draft through another's (MANAGE on both)", async () => {
    const a = await signUp('wardrobe-a@example.com');
    const b = await signUp('wardrobe-b@example.com');
    const manager = await signUp('two-wardrobes@example.com');
    for (const grantor of [a, b]) {
      await t.db.insert(wardrobeShare).values({
        grantorId: grantor.id,
        granteeId: manager.id,
        permission: 'MANAGE',
        inviteToken: randomUUID(),
        createdAt: new Date(),
        acceptedAt: new Date(),
      });
    }
    const cookie = manager.cookie;
    expect(
      (await upload(photos(2), { cookie, ownerId: b.id })).statusCode,
    ).toBe(303);
    const drafts = await draftsOf(manager.id);
    const [first, second] = drafts.map((draft) => draft.fileName) as [
      string,
      string,
    ];
    expect(drafts.every((draft) => draft.batchOwnerId === b.id)).toBe(true);
    const garments = await t.db.$count(garment);
    const files = await t.db.$count(file);
    const originals = await storedOriginals();

    // Through A: the form, the save and the discard are all 404s.
    const page404 = await page(
      `/wardrobe/new?photo=${first}&ownerId=${a.id}`,
      cookie,
    );
    expect(page404.statusCode).toBe(404);
    const save = await t.inject({
      method: 'POST',
      url: `/wardrobe?ownerId=${a.id}`,
      headers: { cookie },
      payload: { category: 'tops', name: 'Wrong closet', linkPhoto: first },
    });
    expect(save.statusCode).toBe(404);
    const discard = await t.inject({
      method: 'POST',
      url: `/wardrobe/new/drafts/discard?ownerId=${a.id}`,
      headers: { cookie },
      payload: { photo: second, saved: '' },
    });
    expect(discard.statusCode).toBe(404);
    // Nor through their own wardrobe.
    const own = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      headers: { cookie },
      payload: { category: 'tops', name: 'Own closet', linkPhoto: first },
    });
    expect(own.statusCode).toBe(404);

    // Nothing was written, claimed or deleted.
    expect(await t.db.$count(garment)).toBe(garments);
    expect(await t.db.$count(file)).toBe(files);
    expect((await draftsOf(manager.id)).map((draft) => draft.fileName)).toEqual(
      [first, second],
    );
    expect(await storedOriginals()).toEqual(originals);
    expect(
      unescapeHtml((await page(`/wardrobe?ownerId=${a.id}`, cookie)).body),
    ).not.toContain(text('drafts.WAITING', { count: 2 }));

    // The claim itself is scoped too, not only the routes' lookup.
    const form = readGarmentForm({ category: 'tops' }, { owner: false });
    if (!form.ok) throw new Error('the fixture form must read');
    const direct = await createGarmentWithPendingPhoto(
      {
        db: t.db,
        photos: t.photos,
        logger: silentLogger,
        cutouts: { wake: () => undefined },
      },
      a.id,
      manager.id,
      form.fields,
      first,
      'closet',
    );
    expect(direct).toBeUndefined();
    expect(await t.db.$count(garment)).toBe(garments);

    // Through B, where the batch was uploaded, both work.
    const saved = await t.inject({
      method: 'POST',
      url: `/wardrobe?ownerId=${b.id}`,
      headers: { cookie },
      payload: { category: 'tops', name: 'Right closet', linkPhoto: first },
    });
    expect(saved.statusCode).toBe(303);
    const [row] = await t.db
      .select({ ownerId: garment.ownerId })
      .from(garment)
      .where(eq(garment.name, 'Right closet'));
    expect(row?.ownerId).toBe(b.id);
    const discarded = await t.inject({
      method: 'POST',
      url: `/wardrobe/new/drafts/discard?ownerId=${b.id}`,
      headers: { cookie },
      payload: { photo: second, saved: '' },
    });
    expect(discarded.statusCode).toBe(303);
    expect(await draftsOf(manager.id)).toEqual([]);
  });
});
