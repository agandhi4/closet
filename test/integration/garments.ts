import sharp from 'sharp';
import { multipart, TestApp } from './harness';

/**
 * The two requests the garment form issues (see views/wardrobe/form.hbs and
 * public/js): create the row, then attach the photo. Shared by the wardrobe,
 * mask-edit and share specs.
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
  // Nest answers every POST with 201 unless the handler opts into @HttpCode;
  // the redirect header is the contract the form relies on.
  expect(res.statusCode).toBeLessThan(300);
  expect(res.headers['hx-redirect']).toBe(
    `/wardrobe/${garmentId}?photoSaved=1`,
  );
}
