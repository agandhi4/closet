import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { expect } from 'vitest';
import { file, garment } from '../../src/db/schema';
import { multipart, TestApp } from './harness';

/**
 * The two requests the garment pages issue (src/web/wardrobe: the form,
 * then the photo form on the garment page): create the row, then attach the
 * photo. Shared by the wardrobe, mask-edit and share specs.
 */

export function jpegPhoto(width = 1200, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#4a6' },
  })
    .jpeg()
    .toBuffer();
}

/** A cutout as the mask editor would upload it: PNG with transparency. */
export function pngCutout(width = 600, height = 400): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 30, b: 30, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}

export interface GarmentRequest {
  name: string;
  category?: string;
  cookie?: string;
  ownerId?: number;
}

/** POST /wardrobe; resolves the new garment's id from the redirect. */
export async function createGarment(
  t: TestApp,
  { name, category = 'shirt', cookie, ownerId }: GarmentRequest,
): Promise<number> {
  const res = await t.inject({
    method: 'POST',
    url: ownerId ? `/wardrobe?ownerId=${ownerId}` : '/wardrobe',
    payload: { name, category },
    headers: cookie ? { cookie } : {},
  });
  expect(res.statusCode).toBe(302);
  const match = /^\/wardrobe\/(\d+)\?/.exec(res.headers.location as string);
  if (!match) {
    throw new Error(`Unexpected create redirect: ${res.headers.location}`);
  }
  return Number(match[1]);
}

/** POST /wardrobe/:id/photo with a multipart `photo` part. */
export async function uploadPhoto(
  t: TestApp,
  garmentId: number,
  photo: Buffer,
  cookie?: string,
): Promise<void> {
  const body = await multipart(
    {},
    {
      photo: { data: photo, filename: 'photo.jpg', contentType: 'image/jpeg' },
    },
  );
  const res = await t.inject({
    method: 'POST',
    url: `/wardrobe/${garmentId}/photo`,
    payload: body.payload,
    headers: { ...body.headers, ...(cookie ? { cookie } : {}) },
  });
  // The redirect header is the contract the form relies on.
  expect(res.statusCode).toBeLessThan(300);
  expect(res.headers['hx-redirect']).toBe(
    `/wardrobe/${garmentId}?photoSaved=1`,
  );
}

/** The `file` row of a stored photo, undefined when there is none. */
export function photoRow(t: TestApp, fileName: string) {
  return t.db.query.file.findFirst({ where: eq(file.fileName, fileName) });
}

/** `file` rows, all of them or one user's. */
export function photoRowCount(t: TestApp, createdById?: number) {
  return t.db.$count(
    file,
    createdById === undefined ? undefined : eq(file.createdById, createdById),
  );
}

/** The garment's row with its photo's `file` row (null without a photo); undefined when gone. */
export function garmentRow(t: TestApp, id: number) {
  return t.db.query.garment.findFirst({
    where: eq(garment.id, id),
    with: { photo: true },
  });
}

/** The stored name of the garment's photo (the test fails without one). */
export async function photoFileName(t: TestApp, id: number): Promise<string> {
  const row = await garmentRow(t, id);
  if (!row?.photo) throw new Error(`Garment ${id} has no photo`);
  return row.photo.fileName;
}

/** Garments with this name, in every wardrobe. */
export function garmentsNamed(t: TestApp, name: string) {
  return t.db.$count(garment, eq(garment.name, name));
}
