import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { file, inspiration } from '../../src/db/schema';
import { multipart, type TestApp } from './harness';

/**
 * Saved looks (#22) for the integration specs, through the requests the
 * pages make: a photo posted from the add page's camera or library button
 * (POST /inspiration, multipart), or a look's own (POST /inspiration/:id/photo).
 */

/** A multipart `photo` posted to `url`, as the upload buttons post it. */
export async function postLookPhoto(
  t: TestApp,
  data: Buffer,
  { cookie, url = '/inspiration' }: { cookie?: string; url?: string } = {},
) {
  const body = await multipart(
    {},
    { photo: { data, filename: 'look.jpg', contentType: 'image/jpeg' } },
  );
  return t.inject({
    method: 'POST',
    url,
    payload: body.payload,
    headers: { ...body.headers, ...(cookie ? { cookie } : {}) },
  });
}

/** The look id a 303 to its page names. */
export function lookIdOf(location: unknown): number {
  const id = Number(/^\/inspiration\/(\d+)(\?|$)/.exec(String(location))?.[1]);
  expect(id, String(location)).toBeGreaterThan(0);
  return id;
}

/** A new look from an uploaded photo; its id and its photo's stored name. */
export async function addLook(
  t: TestApp,
  data: Buffer,
  cookie?: string,
): Promise<{ id: number; fileName: string }> {
  const res = await postLookPhoto(t, data, { cookie });
  expect(res.statusCode, res.body).toBe(303);
  const id = lookIdOf(res.headers.location);
  return { id, fileName: await lookPhotoName(t, id) };
}

/** The stored name of a look's photo; throws for a look without one. */
export async function lookPhotoName(t: TestApp, id: number): Promise<string> {
  const [row] = await t.db
    .select({ fileName: file.fileName })
    .from(inspiration)
    .innerJoin(file, eq(file.id, inspiration.photoId))
    .where(eq(inspiration.id, id));
  if (!row) throw new Error(`Look ${id} has no photo`);
  return row.fileName;
}
