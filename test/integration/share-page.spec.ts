import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file, garment, user } from '../../src/db/schema';
import { t as translate } from '../../src/web/i18n';
import { createGarment } from './garments';
import { createTestApp, OWNER_EMAIL, TestApp, unescapeHtml } from './harness';
import { createPageFixture, expectFullPage, PageFixture } from './pages';

/**
 * GET /share: the public landing page of a share link and the Open Graph
 * tags link-preview crawlers read from it. Rendering of both types is also
 * covered by pages.spec.ts; this pins what the preview says.
 */
describe('share page', () => {
  let t: TestApp;
  let f: PageFixture;
  let photoShareId: string;

  const meta = (html: string, property: string) =>
    new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(
      unescapeHtml(html),
    )?.[1];

  const open = (url: string) =>
    t.inject({ method: 'GET', url, anonymous: true });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createPageFixture(t);
    const [row] = await t.db
      .select({ shareableId: file.shareableId })
      .from(garment)
      .innerJoin(file, eq(file.id, garment.photoId))
      .where(eq(garment.id, f.garmentId));
    photoShareId = row.shareableId;
  });

  afterAll(() => t?.cleanup());

  it("previews a garment with its name and watermarked photo, never its owner's email", async () => {
    const url = `/share?shareableId=${f.garmentShareableId}&type=garment`;
    const res = await open(url);
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
    expect(res.body).toContain('Black Linen Blazer');
    // The owner set no first name: the page names nobody.
    expect(res.body).not.toContain(OWNER_EMAIL);
    expect(res.body).not.toContain('Shared by');
    expect(meta(res.body, 'og:title')).toBe('Black Linen Blazer');
    expect(meta(res.body, 'og:description')).toBe(translate('APP_DESCRIPTION'));
    expect(meta(res.body, 'og:url')).toBe(`http://localhost${url}`);
    expect(meta(res.body, 'og:image')).toBe(
      `http://localhost/file/watermark/${photoShareId}`,
    );

    const image = await open(`/file/watermark/${photoShareId}`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
  });

  it("previews an outfit with its first garment's photo", async () => {
    const res = await open(
      `/share?shareableId=${f.outfitShareableId}&type=outfit`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(OWNER_EMAIL);
    expect(res.body).toContain('Office look');
    expect(res.body).toContain('/file/thumb/');
    expect(meta(res.body, 'og:title')).toBe('Office look');
    expect(meta(res.body, 'og:image')).toBe(
      `http://localhost/file/watermark/${photoShareId}`,
    );
  });

  it('names the owner by first name when they set one, page and preview alike', async () => {
    await t.db
      .update(user)
      .set({ firstName: ' Ada ' })
      .where(eq(user.id, t.owner.id));
    try {
      for (const url of [
        `/share?shareableId=${f.garmentShareableId}&type=garment`,
        `/share?shareableId=${f.outfitShareableId}&type=outfit`,
      ]) {
        const res = await open(url);
        expect(res.body).toContain('Shared by Ada</p>');
        expect(meta(res.body, 'og:description')).toBe('Shared by Ada');
        expect(meta(res.body, 'twitter:description')).toBe('Shared by Ada');
        expect(res.body).not.toContain(OWNER_EMAIL);
      }
    } finally {
      await t.db
        .update(user)
        .set({ firstName: null })
        .where(eq(user.id, t.owner.id));
    }
  });

  it('falls back to the app icon for a garment without a photo', async () => {
    const garmentId = await createGarment(t, { name: 'Plain scarf' });
    const [row] = await t.db
      .select({ shareableId: garment.shareableId })
      .from(garment)
      .where(eq(garment.id, garmentId));
    const res = await open(
      `/share?shareableId=${row.shareableId}&type=garment`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Plain scarf');
    expect(meta(res.body, 'og:image')).toBe('http://localhost/assets/icon.png');
  });

  it.each([
    '/share?shareableId=nothing&type=garment',
    '/share?shareableId=nothing&type=file',
    '/share?type=outfit',
    '/share',
  ])('%s is the empty page, not an error', async (url) => {
    const res = await open(url);
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
    expect(res.body).not.toContain('Shared by');
  });
});
