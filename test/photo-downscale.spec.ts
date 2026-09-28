import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { openPhotoSheet } from './support/garment-page';

/**
 * The phone downscales a picked photo before upload (public/js/
 * photo-input.js, imported by the photo sheet's inputs): to 1600 px on its
 * long side as a JPEG, or unchanged when it is small or the browser cannot
 * decode it (HEIC in Chromium; the server decodes it). Choosing a photo
 * uploads it at once, so the spec reads the file's name and type off the
 * upload itself, and its bytes off the input it was posted from.
 */

const bigPhoto = () =>
  sharp({
    create: { width: 4000, height: 3000, channels: 3, background: '#468' },
  })
    .jpeg()
    .toBuffer();

interface Uploaded {
  name: string;
  type: string;
  width?: number;
  height?: number;
}

/**
 * Opens a new garment's photo sheet and holds its upload: `uploaded` is
 * the photo the page posts (answered 204, so nothing is stored and the page
 * stays).
 */
async function openSheetAndCatchUpload(
  page: Page,
): Promise<{ uploaded: Promise<Uploaded> }> {
  await signIn(page, 'downscale');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Downscaled shirt', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  const id = new URL(created.url()).pathname.split('/').pop();
  await page.goto(`/wardrobe/${id}`);
  await openPhotoSheet(page);

  let answer!: (photo: Uploaded) => void;
  let fail!: (error: Error) => void;
  const uploaded = new Promise<Uploaded>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  await page.route(`**/wardrobe/${id}/photo`, async (route) => {
    const request = route.request();
    let file: File;
    try {
      const body = request.postDataBuffer();
      const form = await new Response(body && new Uint8Array(body), {
        headers: { 'content-type': request.headers()['content-type'] },
      }).formData();
      file = form.get('photo') as File;
    } catch (error) {
      fail(error as Error);
      return route.fulfill({ status: 204 });
    }
    // The bytes are read from the file the form posted from, what
    // preparePhoto left in the input: Playwright's WebKit reports a
    // multipart body without its files' contents, only their names and
    // types. Once answered, as WebKit refuses to read a file while its
    // form's post is in flight.
    await route.fulfill({ status: 204 });
    try {
      const bytes = Buffer.from(
        await page.evaluate(async () => {
          const input =
            document.querySelector<HTMLInputElement>('#photoInput')!;
          return [...new Uint8Array(await input.files![0].arrayBuffer())];
        }),
      );
      const { width, height } = await sharp(bytes)
        .metadata()
        .catch(() => ({ width: undefined, height: undefined }));
      answer({ name: file.name, type: file.type, width, height });
    } catch (error) {
      fail(error as Error);
    }
  });
  return { uploaded };
}

test('a large photo goes up as a 1600 px JPEG', async ({ page }) => {
  const { uploaded } = await openSheetAndCatchUpload(page);
  await page.locator('#photoInput').setInputFiles({
    name: 'IMG_0001.jpeg',
    mimeType: 'image/jpeg',
    buffer: await bigPhoto(),
  });
  expect(await uploaded).toEqual({
    name: 'IMG_0001.jpg',
    type: 'image/jpeg',
    width: 1600,
    height: 1200,
  });
});

test('a photo the browser cannot decode goes up as it is', async ({ page }) => {
  const { uploaded } = await openSheetAndCatchUpload(page);
  await page.locator('#photoInput').setInputFiles({
    name: 'IMG_0002.heic',
    mimeType: 'image/heic',
    buffer: readFileSync(path.join(__dirname, 'fixtures', 'example.heic')),
  });
  expect(await uploaded).toMatchObject({
    name: 'IMG_0002.heic',
    type: 'image/heic',
  });
});
