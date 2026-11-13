import { eq } from 'drizzle-orm';
import { readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file, inspiration, pendingPhoto } from '../../src/db/schema';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import { variantFileName } from '../../src/web/files/image-variant';
import { t as text } from '../../src/web/i18n';
import { jpegPhoto, photoRow } from './garments';
import {
  createTestApp,
  extractImgSrcs,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { addLook, lookIdOf, lookPhotoName, postLookPhoto } from './inspiration';
import {
  html,
  INTRANET_HOST,
  jpeg,
  type LinkSites,
  startLinkSites,
} from './link-sites';
import { silentLogger } from './logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Saved looks (#22, slice 22a): adding one from a photo or a pasted link,
 * its page's title and note, its photo added, replaced and deleted with
 * it, and the photo's references (private like a selfie's; never an orphan
 * to reconciliation). Who may reach them is the authorization matrix's
 * (authorization-outfits.routes.ts).
 */
describe('inspiration', () => {
  let t: TestApp;
  let sites: LinkSites;
  let photo: Buffer;

  const stored = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const lookRow = async (id: number) => {
    const [row] = await t.db
      .select()
      .from(inspiration)
      .where(eq(inspiration.id, id));
    return row;
  };

  const pasteLink = (url: string) =>
    t.inject({ method: 'POST', url: '/inspiration/link', payload: { url } });

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    photo = await jpegPhoto(600, 800);
    sites.serve('/look.jpg', jpeg(photo));
    sites.serve(
      '/lookbook',
      html(
        `<html><head><title>Navy blazer, white tee</title><meta property="og:image" content="${sites.url('/look.jpg')}"></head><body></body></html>`,
      ),
    );
    sites.serve(
      '/words',
      html('<html><head><title>Words only</title></head><body></body></html>'),
    );
    sites.serve('/blocked', {
      status: 403,
      type: 'text/html',
      body: '<title>Just a moment...</title>',
      headers: { 'cf-mitigated': 'challenge' },
    });
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('saves an upload as a look with a private photo and no cutout, listed newest first', async () => {
    const first = await addLook(t, photo);
    const second = await addLook(t, photo);
    const row = await photoRow(t, second.fileName);
    // A look is a whole picture: nothing is queued for background removal.
    expect(row?.cutoutStatus).toBe('unwanted');

    let list!: Awaited<ReturnType<typeof t.inject>>;
    const { statements } = await recordQueries(async () => {
      list = await t.inject({ method: 'GET', url: '/inspiration' });
    });
    expect(list.statusCode).toBe(200);
    // The session's, then the list's one.
    expect(statements).toBe(2);
    const thumbs = extractImgSrcs(unescapeHtml(list.body)).filter((src) =>
      src.startsWith('/inspiration/photo/thumb/'),
    );
    expect(thumbs).toEqual([
      `/inspiration/photo/thumb/${second.fileName}?v=1`,
      `/inspiration/photo/thumb/${first.fileName}?v=1`,
    ]);
    expect(list.body).toContain('role="tab"');
    expect(list.body).toContain(text('gallery.TAB_INSPIRATION'));

    for (const url of [
      `/inspiration/photo/${second.fileName}?v=1`,
      `/inspiration/photo/thumb/${second.fileName}?v=1`,
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toContain('private');
    }
    // Never public by name: the /file/** routes refuse it, the owner too.
    for (const variant of ['', 'thumb/', 'nobg/']) {
      const res = await t.inject({
        method: 'GET',
        url: `/file/${variant}${second.fileName}?v=1`,
      });
      expect(res.statusCode, variant).toBe(404);
    }
    expect(t.logs.messages('info')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Inspiration ${second.id} saved by user \\d+ from an upload`,
        ),
      ),
    );
  });

  it('saves a pasted page with its title and its photo, the pending photo claimed', async () => {
    const res = await pasteLink(`Look at this ${sites.url('/lookbook')}`);
    expect(res.statusCode, res.body).toBe(303);
    const id = lookIdOf(res.headers.location);
    expect(res.headers.location).toBe(`/inspiration/${id}`);
    const look = await lookRow(id);
    expect(look).toMatchObject({
      title: 'Navy blazer, white tee',
      sourceUrl: sites.url('/lookbook'),
    });
    const fileName = await lookPhotoName(t, id);
    expect((await photoRow(t, fileName))?.cutoutStatus).toBe('unwanted');
    expect(
      await t.db.$count(pendingPhoto, eq(pendingPhoto.fileName, fileName)),
    ).toBe(0);

    const page = await t.inject({ method: 'GET', url: `/inspiration/${id}` });
    expect(page.statusCode).toBe(200);
    const body = unescapeHtml(page.body);
    expect(body).toContain(`/inspiration/photo/${fileName}?v=1`);
    expect(body).toContain('rel="noopener noreferrer"');
    expect(body).toContain(
      text('inspiration.OPEN_LINK', { host: 'shop.test' }),
    );
  });

  it('keeps a link it could not get a photo from, and says why once', async () => {
    const blocked = await pasteLink(sites.url('/blocked'));
    expect(blocked.statusCode).toBe(303);
    expect(blocked.headers.location).toMatch(/\?unread=blocked-by-site$/);
    const id = lookIdOf(blocked.headers.location);
    expect(await lookRow(id)).toMatchObject({
      sourceUrl: sites.url('/blocked'),
      photoId: null,
    });
    const page = await t.inject({
      method: 'GET',
      url: blocked.headers.location,
    });
    const body = unescapeHtml(page.body);
    expect(body).toContain(text('linkImport.BLOCKED_BY_SITE'));
    expect(body).toContain(text('inspiration.NO_PHOTO'));
    // Unknown URL state is no note, never a 400.
    const odd = await t.inject({
      method: 'GET',
      url: `/inspiration/${id}?unread=nonsense`,
    });
    expect(odd.statusCode).toBe(200);
    expect(unescapeHtml(odd.body)).not.toContain(text('inspiration.UNREAD'));

    const words = await pasteLink(sites.url('/words'));
    expect(words.headers.location).toMatch(/\?unread=no-photo$/);
    expect(await lookRow(lookIdOf(words.headers.location))).toMatchObject({
      title: 'Words only',
      photoId: null,
    });
  });

  it.each([
    ['no link', 'just some words', 400, 'linkImport.NO_LINK'],
    [
      'a private address',
      `http://${INTRANET_HOST}/look`,
      400,
      'linkImport.BLOCKED_ADDRESS',
    ],
  ] as const)(
    'refuses %s: the add page again with the reason, nothing saved',
    async (_case, url, status, message) => {
      const before = await t.db.$count(inspiration);
      const res = await pasteLink(url);
      expect(res.statusCode).toBe(status);
      const body = unescapeHtml(res.body);
      expect(body).toContain(text(message));
      expect(body).toContain(`value="${url}"`);
      expect(await t.db.$count(inspiration)).toBe(before);
    },
  );

  it('saves the title and note as they change; a blank is none, too long a 400', async () => {
    const { id } = await addLook(t, photo);
    const save = (payload: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: `/inspiration/${id}`,
        payload,
        headers: { 'hx-request': 'true' },
      });
    const saved = await save({ title: '  Café look ', note: 'The coat' });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain(text('SAVED'));
    expect(await lookRow(id)).toMatchObject({
      title: 'Café look',
      note: 'The coat',
    });
    await save({ title: '', note: '  ' });
    expect(await lookRow(id)).toMatchObject({ title: null, note: null });
    expect((await save({ title: 'x'.repeat(256), note: '' })).statusCode).toBe(
      400,
    );
  });

  it('adds a photo to a link saved without one, and replaces it, unlinking the old', async () => {
    const id = lookIdOf(
      (await pasteLink(sites.url('/blocked'))).headers.location,
    );
    const added = await postLookPhoto(t, photo, {
      url: `/inspiration/${id}/photo`,
    });
    expect(added.statusCode).toBe(303);
    expect(added.headers.location).toBe(`/inspiration/${id}`);
    const firstName = await lookPhotoName(t, id);

    const replaced = await postLookPhoto(t, photo, {
      url: `/inspiration/${id}/photo`,
    });
    expect(replaced.statusCode).toBe(303);
    const secondName = await lookPhotoName(t, id);
    expect(secondName).not.toBe(firstName);
    expect(await photoRow(t, firstName)).toBeUndefined();
    expect(await stored()).not.toContain(firstName);
    expect(await stored()).toContain(secondName);
  });

  it('deletes a look with its photo, row and bytes', async () => {
    const { id, fileName } = await addLook(t, photo);
    // Its thumb made, so the whole set is on disk.
    await t.inject({
      method: 'GET',
      url: `/inspiration/photo/thumb/${fileName}?v=1`,
    });
    expect(await stored()).toContain(variantFileName(fileName, 'thumb'));

    const res = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/delete`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/inspiration');
    expect(await lookRow(id)).toBeUndefined();
    expect(await photoRow(t, fileName)).toBeUndefined();
    const files = await stored();
    expect(files).not.toContain(fileName);
    expect(files).not.toContain(variantFileName(fileName, 'thumb'));
    const gone = await t.inject({ method: 'GET', url: `/inspiration/${id}` });
    expect(gone.statusCode).toBe(404);
  });

  // Before photoIsReferenced counted looks, every look's photo was an
  // unreferenced `file` row, deleted the night after it was saved.
  it('is never an orphan to storage reconciliation', async () => {
    const { id, fileName } = await addLook(t, photo);
    const then = new Date(Date.now() - 3 * DAY_MS);
    await t.db
      .update(file)
      .set({ createdOn: then.toISOString() })
      .where(eq(file.fileName, fileName));
    await utimes(join(t.dataPath, fileName), then, then);

    const report = await reconcileStorage({
      db: t.db,
      photos: t.photos,
      logger: silentLogger,
    });
    expect(report.refused).toBeUndefined();
    expect(report).toMatchObject({
      orphanedRowsDeleted: 0,
      orphanedObjectsDeleted: 0,
    });
    expect(await photoRow(t, fileName)).toBeDefined();
    expect(await stored()).toContain(fileName);
    expect((await lookRow(id)).photoId).not.toBeNull();
  });
});
