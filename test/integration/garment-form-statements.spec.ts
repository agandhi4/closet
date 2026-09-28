import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, pendingPhoto } from '../../src/db/schema';
import { MAX_PENDING_PER_USER } from '../../src/web/files/pending-photos';
import { t as text } from '../../src/web/i18n';
import { createGarment, jpegPhoto, pngCutout, uploadPhoto } from './garments';
import {
  createTestApp,
  type MultipartFile,
  multipart,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';

/**
 * What adding and editing a garment costs in statements (#161): production
 * reaches Postgres over a link of ~114 ms a round trip (#156), so the count
 * is the latency. Every garment form reads what it shows in one statement
 * (formContext) after the session's, and after the garment for an edit or
 * a clone. The behaviour of each route is its own spec's (garment-edit,
 * lookalikes, link-import, add-from-photo, draft-batch, wishlist); this one
 * pins the statements, and proves the reads that were narrowed or dropped
 * fed nothing the page shows.
 */

const OWNER_EMAIL = 'owner@example.com';

describe('garment form statements (#161)', () => {
  let t: TestApp;
  let sites: LinkSites;
  let ownerId: number;
  let photoBytes: Buffer;
  /** A closet tee with a photo, a brand note and a repair: every part of the edit page. */
  let tee: number;

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
  const post = (url: string, fields: Record<string, string | string[]>) =>
    t.inject({ method: 'POST', url, ...form(fields) });
  const get = (url: string) => t.inject({ method: 'GET', url });

  const photo = (): MultipartFile => ({
    data: photoBytes,
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
  });
  const upload = async (count: number) => {
    const body = await multipart(
      {},
      { photo: Array.from({ length: count }, photo) },
    );
    return t.inject({
      method: 'POST',
      url: '/wardrobe/new/photo',
      payload: body.payload,
      headers: body.headers,
    });
  };
  /** An upload's pending photo, or its batch's first draft. */
  const uploaded = async (count = 1): Promise<string> => {
    const res = await upload(count);
    expect(res.statusCode).toBe(303);
    const name = new URL(
      String(res.headers.location),
      'http://localhost',
    ).searchParams.get('photo');
    return name!;
  };

  /** The one statement of `record` that reads `table`, and that there is one. */
  const onlyStatementReading = (sql: string[], table: string) => {
    const reads = sql.filter((text) => text.includes(`"${table}"`));
    expect(reads).toHaveLength(1);
    return reads[0];
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    sites.serve('/img/front.jpg', jpeg(await productShot('#223355')));
    sites.serve(
      '/products/tee',
      html(
        `<script type="application/ld+json">${JSON.stringify({
          '@type': 'Product',
          name: 'Pocket Tee',
          brand: { '@type': 'Brand', name: 'Uniqlo' },
          color: 'Blue',
          image: [sites.url('/img/front.jpg')],
        })}</script>`,
      ),
    );
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    ownerId = await userIdOf(t, OWNER_EMAIL);
    photoBytes = await jpegPhoto(300, 400);

    const res = await post('/wardrobe', {
      name: 'Blue tee',
      category: 'tops',
      brand: 'Uniqlo',
      color: 'blue',
      props: '1',
      type: 't-shirt',
      size: 'M',
    });
    expect(res.statusCode).toBe(302);
    tee = Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
    await uploadPhoto(t, tee, photoBytes);
    // Its cutout (a mask saved, keyed): what a clone copies with the photo.
    const cutout = await multipart(
      {},
      {
        nobgPhoto: {
          data: await pngCutout(),
          filename: 'cutout.png',
          contentType: 'image/png',
        },
      },
    );
    expect(
      (
        await t.inject({
          method: 'POST',
          url: `/wardrobe/${tee}/nobg`,
          payload: cutout.payload,
          headers: cutout.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post('/auth/profile/sizes/brands', {
          brand: 'Uniqlo',
          size: 'M',
          note: 'Runs large',
        })
      ).statusCode,
    ).toBe(303);
    expect(
      (
        await post(`/wardrobe/${tee}/repairs`, {
          day: t.today(),
          kind: 'alteration',
          note: 'Hem',
        })
      ).statusCode,
    ).toBe(303);
    // A custom category of the wardrobe's own, among its suggestions.
    await createGarment(t, { name: 'Obi', category: 'sash' });
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  describe('the forms', () => {
    it('the add form: the session and the form, the categories alone', async () => {
      const record = await recordQueries(() => get('/wardrobe/new'));
      expect(record.statements).toBe(2);
      // The suggestions are the only list the form shows of the wardrobe:
      // none of the grid's filter options (sizes, types, materials) is read.
      const [, formRead] = record.sql;
      expect(formRead).toContain('"category"');
      expect(formRead).not.toContain('unnest');
      expect(formRead).not.toContain('"size"');
      const res = await get('/wardrobe/new');
      expect(res.body).toContain('value="sash"');
    });

    it('the edit page: the garment, then its repairs and brand note with the form', async () => {
      const record = await recordQueries(() => get(`/wardrobe/${tee}/edit`));
      expect(record.statements).toBe(3);
      const formRead = onlyStatementReading(record.sql, 'garment_repair');
      expect(formRead).toContain('"brand_size"');
      const body = unescapeHtml((await get(`/wardrobe/${tee}/edit`)).body);
      expect(body).toContain('Hem');
      expect(body).toContain('Runs large');
    });

    it('the clone form: the garment, then the duplicate check with the form', async () => {
      const record = await recordQueries(() => get(`/wardrobe/${tee}/clone`));
      expect(record.statements).toBe(3);
      onlyStatementReading(record.sql.slice(2), 'brand_size');
      // A clone of the tee is the tee's lookalike.
      const body = (await get(`/wardrobe/${tee}/clone`)).body;
      expect(body).toContain(`data-lookalike="${tee}"`);
    });

    it('a pending photo: the form checks it in its own statement', async () => {
      const name = await uploaded();
      const record = await recordQueries(() =>
        get(`/wardrobe/new?photo=${name}`),
      );
      expect(record.statements).toBe(2);
      onlyStatementReading(record.sql, 'pending_photo');
    });

    it('a draft: its queue rides in the form statement too', async () => {
      const first = await uploaded(3);
      const record = await recordQueries(() =>
        get(`/wardrobe/new?photo=${first}`),
      );
      expect(record.statements).toBe(2);
      onlyStatementReading(record.sql, 'pending_photo');
      const body = (await get(`/wardrobe/new?photo=${first}`)).body;
      expect(body).toContain('id="draft-queue"');
    });

    it('the properties fragment reads nothing but the session', async () => {
      const record = await recordQueries(() =>
        t.inject({
          method: 'POST',
          url: '/wardrobe/properties-fragment',
          headers: {
            ...form({}).headers,
            'hx-request': 'true',
          },
          payload: form({ category: 'footwear' }).payload,
        }),
      );
      expect(record.statements).toBe(1);
    });

    it('the lookalike check reads only the category’s garments of the same type and colours', async () => {
      // Same category, another colour: never a match, so never read.
      await post('/wardrobe', {
        name: 'Red tee',
        category: 'tops',
        color: 'red',
        props: '1',
        type: 't-shirt',
      });
      const url =
        '/wardrobe/lookalikes?category=tops&type=t-shirt&color=blue&brand=Uniqlo';
      const record = await recordQueries(() =>
        t.inject({ method: 'GET', url, headers: { 'hx-request': 'true' } }),
      );
      expect(record.statements).toBe(2);
      const res = await t.inject({
        method: 'GET',
        url,
        headers: { 'hx-request': 'true' },
      });
      expect(res.body).toContain(`data-lookalike="${tee}"`);
    });
  });

  describe('the saves', () => {
    it('a new garment is its insert alone', async () => {
      const record = await recordQueries(() =>
        post('/wardrobe', { name: 'Plain', category: 'tops' }),
      );
      expect(record.statements).toBe(2);
      expect(record.sql.join('\n')).not.toMatch(/^begin/m);
    });

    it('a refused new garment is the form again, in one statement', async () => {
      const record = await recordQueries(() =>
        post('/wardrobe', { name: 'No category', category: '' }),
      );
      expect(record.statements).toBe(2);
    });

    it('an edit is its update alone; a refused one reads the garment for the form', async () => {
      const saved = await recordQueries(() =>
        post(`/wardrobe/${tee}`, {
          name: 'Blue tee',
          category: 'tops',
          brand: 'Uniqlo',
          color: 'blue',
        }),
      );
      expect(saved.statements).toBe(2);
      const refused = await recordQueries(() =>
        post(`/wardrobe/${tee}`, { name: 'Blue tee', category: '' }),
      );
      expect(refused.statements).toBe(3);
    });

    it('an edit of a garment that is gone is still a 404, writing nothing', async () => {
      const res = await post('/wardrobe/999999', {
        name: 'Ghost',
        category: 'tops',
      });
      expect(res.statusCode).toBe(404);
    });

    it('a pending photo: the claim transaction, its take one statement', async () => {
      const name = await uploaded();
      const record = await recordQueries(() =>
        post('/wardrobe', {
          name: 'From a photo',
          category: 'tops',
          linkPhoto: name,
        }),
      );
      // session, begin, the name's lock, the take, the file row, the
      // garment, commit.
      expect(record.statements).toBe(7);
      onlyStatementReading(record.sql, 'pending_photo');
    });

    it('a draft: the take answers the next draft, so nothing is read after', async () => {
      const first = await uploaded(2);
      const record = await recordQueries(() =>
        post('/wardrobe', {
          name: 'Draft one',
          category: 'tops',
          linkPhoto: first,
        }),
      );
      expect(record.statements).toBe(7);
      // The same draft again: claimed already, the form says so (one more
      // statement, only on this refusal: why the take found nothing).
      const again = await recordQueries(async () => {
        const res = await post('/wardrobe', {
          name: 'Draft one again',
          category: 'tops',
          linkPhoto: first,
        });
        expect(res.statusCode).toBe(400);
        expect(unescapeHtml(res.body)).toContain(text('add.PHOTO_GONE'));
      });
      expect(again.statements).toBe(7);
    });

    it('a discard: the take alone, in the name’s lock', async () => {
      const first = await uploaded(2);
      const record = await recordQueries(() =>
        post('/wardrobe/new/drafts/discard', { photo: first }),
      );
      // session, begin, the lock, the take (with the queue), commit.
      expect(record.statements).toBe(5);
      onlyStatementReading(record.sql, 'pending_photo');
    });

    it('the discard leaves a single pending photo alone', async () => {
      const single = await uploaded();
      const res = await post('/wardrobe/new/drafts/discard', { photo: single });
      expect(res.statusCode).toBe(303);
      const [row] = await t.db
        .select({ fileName: pendingPhoto.fileName })
        .from(pendingPhoto)
        .where(eq(pendingPhoto.fileName, single));
      expect(row?.fileName).toBe(single);
    });

    it('an upload: the room left, then the insert that takes the lock and the eviction', async () => {
      const record = await recordQueries(() => upload(1));
      // session, drafts held, begin, insert (with the lock), eviction, commit.
      expect(record.statements).toBe(6);
      const insert = onlyStatementReading(
        record.sql.filter((text) => text.startsWith('insert')),
        'pending_photo',
      );
      expect(insert).toContain('pg_advisory_xact_lock');
    });

    it('still keeps MAX_PENDING_PER_USER unbatched photos, the lock taken by the insert', async () => {
      // Two at a time, as two phones would: the lock orders the evictions.
      for (let i = 0; i < MAX_PENDING_PER_USER; i++) {
        await Promise.all([uploaded(), uploaded()]);
      }
      const unbatched = await t.db.$count(
        pendingPhoto,
        and(eq(pendingPhoto.userId, ownerId), isNull(pendingPhoto.batchId)),
      );
      expect(unbatched).toBe(MAX_PENDING_PER_USER);
    });

    it('a link import: the pending photo’s transaction, then the form', async () => {
      const record = await recordQueries(() =>
        post('/wardrobe/new/from-link', { url: sites.url('/products/tee') }),
      );
      // session, begin, insert (with the lock), eviction, commit, the form.
      expect(record.statements).toBe(6);
    });

    it('a clone: the garment, then the copy’s rows (its key read with the garment)', async () => {
      const record = await recordQueries(() =>
        post(`/wardrobe/${tee}/clone`, { name: 'Tee again', category: 'tops' }),
      );
      // session, the garment, begin, the file row, the garment, commit:
      // the cutout's key came with the garment, never read again.
      expect(record.statements).toBe(6);
      expect(record.sql.join('\n')).not.toContain('"variant_key" from');
    });

    it('a copy: one guarded update under the owner lock', async () => {
      const record = await recordQueries(() =>
        post(`/wardrobe/${tee}/copies`, {}),
      );
      // session, begin, the owner lock, the update, commit.
      expect(record.statements).toBe(5);
      const [row] = await t.db
        .select({ quantity: garment.quantity })
        .from(garment)
        .where(eq(garment.id, tee));
      expect(row.quantity).toBe(2);
    });

    it('a delete: the delete answers the status, no read before it', async () => {
      const plain = await createGarment(t, {
        name: 'Doomed',
        category: 'tops',
      });
      const record = await recordQueries(() =>
        t.inject({
          method: 'DELETE',
          url: `/wardrobe/${plain}`,
          headers: { 'hx-request': 'true' },
        }),
      );
      // session, begin, the delete, commit (no photo row to delete).
      expect(record.statements).toBe(4);
    });
  });
});
