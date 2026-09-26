import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { recordCutoutEvent } from '../../src/cutout/queries';
import type { CutoutMask, CutoutRunner } from '../../src/cutout/runner';
import { variantFileName } from '../../src/web/files/image-variant';
import type { TestApp } from './harness';

/**
 * Server-side background removal without the model: a fake runner for
 * t.cutouts.start(), and readers for what the queue left behind. Shared by
 * the queue and upload specs.
 */

/** The fake model's square side. */
export const MASK_SIZE = 16;

/** Background on the left half, garment on the right. */
export function halfMask(): Buffer {
  const mask = Buffer.alloc(MASK_SIZE * MASK_SIZE);
  for (let y = 0; y < MASK_SIZE; y++) {
    mask.fill(255, y * MASK_SIZE + MASK_SIZE / 2, (y + 1) * MASK_SIZE);
  }
  return mask;
}

export interface FakeRunner extends CutoutRunner {
  /** Images masked (or attempted) so far. */
  calls: number;
  closed: boolean;
}

/**
 * A runner answering every image with `answer(call)` (1-based): a mask,
 * or a rejection for a failed run. halfMask() by default.
 */
export function fakeRunner(
  answer: (call: number) => Promise<Buffer> | Buffer = () => halfMask(),
): FakeRunner {
  const runner: FakeRunner = {
    inputSize: MASK_SIZE,
    calls: 0,
    closed: false,
    async mask(rgb: Buffer): Promise<CutoutMask> {
      if (rgb.length !== MASK_SIZE * MASK_SIZE * 3) {
        throw new Error(`Expected ${MASK_SIZE}px RGB, got ${rgb.length} bytes`);
      }
      runner.calls += 1;
      return { mask: await answer(runner.calls), inferenceMs: 7 };
    },
    close() {
      runner.closed = true;
      return Promise.resolve();
    },
  };
  return runner;
}

/** Queues the photo as a server-mode upload does (`request`). */
export async function requestCutout(t: TestApp, fileName: string) {
  const outcome = await recordCutoutEvent(t.db, fileName, { type: 'request' });
  if (!outcome.ok) throw new Error(`request refused: ${outcome.reason}`);
}

/** The stored cutout's bytes, undefined when there is none. */
export function storedCutout(t: TestApp, fileName: string) {
  return readFile(join(t.dataPath, variantFileName(fileName, 'nobg'))).catch(
    () => undefined,
  );
}

/** The alpha (0-255) of the pixel at x, y of a WebP with transparency. */
export async function alphaAt(
  image: Buffer,
  x: number,
  y: number,
): Promise<number> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3];
}
