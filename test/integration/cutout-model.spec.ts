import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIREFNET_512, CutoutModel } from '../../src/cutout/model';
import { ModelRunner } from '../../src/cutout/runner';
import { PROJECT_ROOT } from '../../src/project-root';
import { alphaAt, storedCutout } from './cutouts';
import {
  createGarment,
  photoFileName,
  photoRow,
  uploadPhoto,
} from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * The real model end to end: the queue, the child process (src/cutout/
 * child.ts under Node's type stripping), onnxruntime and BiRefNet. Runs
 * only where the 940 MB model file already is: MODELS_PATH (as the server
 * reads it) or ./models. CI never downloads it, so there this is skipped.
 * Seed it with `npm run cutout:fetch-model`.
 */
const modelsPath = process.env.MODELS_PATH ?? join(PROJECT_ROOT, 'models');
const present = existsSync(join(modelsPath, BIREFNET_512.fileName));

// A red garment shape on a pale, slightly noisy backdrop: plain enough to
// judge, textured enough that the model is not handed a trivial image.
async function garmentPhoto(): Promise<Buffer> {
  const width = 1200;
  const height = 1600;
  const shirt = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <path d="M380 300 L520 240 Q600 300 680 240 L820 300 L960 520 L840 600 L820 540 L820 1300 L380 1300 L380 540 L360 600 L240 520 Z"
        fill="#b3262a" stroke="#7a1a1d" stroke-width="8"/>
    </svg>`,
  );
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i++) {
    noise[i] = 225 + Math.floor(Math.random() * 20);
  }
  return sharp(noise, { raw: { width, height, channels: 3 } })
    .composite([{ input: shirt }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe.skipIf(!present)(
  `the real model (${BIREFNET_512.fileName} in MODELS_PATH, else skipped)`,
  () => {
    let t: TestApp;

    beforeAll(async () => {
      t = await createTestApp();
    });

    afterAll(() => t?.cleanup());

    it('cuts the garment out of a photo', async () => {
      const garmentId = await createGarment(t, { name: 'Real model shirt' });
      await uploadPhoto(t, garmentId, await garmentPhoto());
      const fileName = await photoFileName(t, garmentId);
      const logger = t.logger.child({ context: 'Cutout' });

      // The upload queued it; the job runs once the queue starts.
      const startedAt = Date.now();
      t.cutouts.start(
        new ModelRunner({
          model: new CutoutModel(BIREFNET_512, modelsPath, logger),
          threads: 4,
          logger,
        }),
      );
      await t.cutouts.whenIdle();
      const elapsedMs = Date.now() - startedAt;

      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'ready',
      });
      // Stored at 810x1080, centred on a 1080 square: the shirt's body is
      // kept, the backdrop beside it and the padding are cleared.
      const cutout = (await storedCutout(t, fileName))!;
      expect(await alphaAt(cutout, 540, 700)).toBeGreaterThan(200);
      expect(await alphaAt(cutout, 180, 1000)).toBeLessThan(40);
      expect(await alphaAt(cutout, 60, 540)).toBe(0);

      // A second photo finds the model loaded.
      const warmId = await createGarment(t, { name: 'Real model shirt 2' });
      const warmStartedAt = Date.now();
      await uploadPhoto(t, warmId, await garmentPhoto());
      await t.cutouts.whenIdle();
      const warmMs = Date.now() - warmStartedAt;

      console.info(
        `Real model: pending -> ready in ${elapsedMs} ms cold (model verify and load included), ${warmMs} ms warm\n  ${t.logs
          .messages('info', 'Cutout')
          .filter((line) => /Cutout ready|loaded the model|verified/.test(line))
          .join('\n  ')}`,
      );
    }, 120_000);
  },
);
