import { expect, type Locator, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { openPhotoSheet } from './support/garment-page';

/**
 * The mask editor's brushes (public/js/mask-editor.js), judged by the
 * cutout the server stored: erasing clears the cutout under the stroke,
 * restoring paints the original back (over an erased stroke, and where the
 * model had cleared the background), and what no stroke touched keeps its
 * pixels. test/cutout.spec.ts covers opening and saving without a stroke.
 *
 * The cutout comes from the test server's stub model (an ellipse of the
 * photo, as soon as the queue reaches it, test/support/cutout-stub.ts). Positions are
 * fractions of the cutout's padded square, which the canvas shows whole.
 */

/** The photo: portrait, one colour, so a restored pixel is known. */
const PHOTO = { width: 900, height: 1200, rgb: [40, 90, 200] as const };

/** A pixel of a stored cutout, at fractions of its square. */
interface Pixel {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

async function pixelsAt(
  image: Buffer,
  points: Record<string, [number, number]>,
): Promise<Record<string, Pixel>> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels: Record<string, Pixel> = {};
  for (const [name, [fx, fy]] of Object.entries(points)) {
    const x = Math.round(fx * (info.width - 1));
    const y = Math.round(fy * (info.height - 1));
    const at = (y * info.width + x) * info.channels;
    pixels[name] = {
      r: data[at],
      g: data[at + 1],
      b: data[at + 2],
      alpha: data[at + 3],
    };
  }
  return pixels;
}

/** Drags the brush from one point to another, as a mouse stroke. */
async function stroke(
  page: Page,
  canvas: Locator,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const box = (await canvas.boundingBox())!;
  const at = ([fx, fy]: [number, number]) =>
    [box.x + fx * box.width, box.y + fy * box.height] as const;
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at(to), { steps: 12 });
  await page.mouse.up();
}

test('erase and restore strokes land on the saved cutout, and nothing else changes', async ({
  page,
}) => {
  // Tall enough that the whole canvas is on screen in the dialog.
  await page.setViewportSize({ width: 800, height: 1000 });
  await signIn(page, 'mask-editor');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Masked shirt', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  expect(created.ok()).toBe(true);
  const garmentId = new URL(created.url()).pathname.split('/').pop();

  await page.goto(`/wardrobe/${garmentId}`);
  await openPhotoSheet(page);
  const [r, g, b] = PHOTO.rgb;
  await page.locator('#photoInput').setInputFiles({
    name: 'shirt.png',
    mimeType: 'image/png',
    buffer: await sharp({
      create: {
        width: PHOTO.width,
        height: PHOTO.height,
        channels: 3,
        background: { r, g, b },
      },
    })
      .png()
      .toBuffer(),
  });
  const photo = page.locator('#garment-photo img');
  await expect(photo).toHaveAttribute(
    'src',
    /^\/file\/nobg\/.+\?v=2&k=[0-9a-f]{12}&s=[\w-]{16}$/,
    {
      timeout: 15_000,
    },
  );

  // Where the strokes go. The photo fills the square's middle 3/4 across
  // (portrait, padded to a square) and all of its height; the stub's
  // ellipse covers its centre.
  const points: Record<string, [number, number]> = {
    erased: [0.4, 0.5], // erase stroke only
    erasedRestored: [0.6, 0.5], // erase stroke, then restore
    background: [0.22, 0.1], // cleared by the model, then restored
    untouchedGarment: [0.5, 0.8],
    untouchedBackground: [0.8, 0.1],
    padding: [0.05, 0.5],
  };
  const cutout = async () => {
    const src = (await photo.getAttribute('src'))!;
    const response = await page.request.get(src);
    expect(response.ok()).toBe(true);
    return pixelsAt(await response.body(), points);
  };
  const before = await cutout();
  // What the model left: the garment opaque, the background and padding clear.
  for (const name of ['erased', 'erasedRestored', 'untouchedGarment']) {
    expect(before[name].alpha, name).toBeGreaterThan(245);
  }
  for (const name of ['background', 'untouchedBackground', 'padding']) {
    expect(before[name].alpha, name).toBeLessThan(10);
  }

  await page.locator('#editMaskBtn').click();
  const canvas = page.locator('#maskEditorCanvas');
  await expect(page.locator('#maskEditorDialog')).toBeVisible();
  // Both images are drawn once the canvas takes the cutout's size.
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
    .toBeGreaterThan(300);

  // Erase is the brush the editor opens with.
  await expect(page.locator('#maskBrushErase')).toHaveClass(/btn-active/);
  await stroke(page, canvas, [0.35, 0.5], [0.65, 0.5]);
  await page.locator('#maskBrushRestore').click();
  await expect(page.locator('#maskBrushRestore')).toHaveClass(/btn-active/);
  await stroke(page, canvas, [0.58, 0.5], [0.62, 0.5]);
  await stroke(page, canvas, [0.2, 0.1], [0.24, 0.1]);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/wardrobe/${garmentId}/nobg`) &&
      response.request().method() === 'POST',
  );
  await page.locator('#maskEditorAccept').click();
  expect((await saved).status()).toBe(200);
  await expect(photo).toHaveAttribute(
    'src',
    /\?v=3&k=[0-9a-f]{12}&s=[\w-]{16}$/,
  );

  const after = await cutout();
  const photoColour = (pixel: Pixel) => {
    expect(pixel.alpha).toBeGreaterThan(245);
    for (const [channel, want] of [
      ['r', r],
      ['g', g],
      ['b', b],
    ] as const) {
      expect(Math.abs(pixel[channel] - want), channel).toBeLessThan(16);
    }
  };
  expect(after.erased.alpha).toBeLessThan(10);
  photoColour(after.erasedRestored);
  photoColour(after.background);
  photoColour(after.untouchedGarment);
  expect(after.untouchedBackground.alpha).toBeLessThan(10);
  expect(after.padding.alpha).toBeLessThan(10);
});
