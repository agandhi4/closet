import { join, resolve } from 'node:path';
import type * as ConfigModule from '../../src/config';
import type { CutoutRunner } from '../../src/cutout/runner';
import type * as LoggerModule from '../../src/logger';
import type * as ServerModule from '../../src/server';

/**
 * The built server (dist/, `npm run build` first) as src/main.ts boots it,
 * with one difference: background removal runs a stub instead of the 940 MB
 * model, which no test downloads. Playwright (playwright.config.ts), the
 * load test (scripts/load-test.ts) and Lighthouse (lighthouserc.js) start
 * it with `npm run start:test`; an upload goes pending and its cutout
 * arrives STUB_DELAY_MS later, as in production. Configuration is the
 * environment's, as for main.ts.
 */

const DIST = join(resolve(__dirname, '..', '..'), 'dist');

// Long enough that the page after an upload always sees the cutout pending
// and polls at least once (every 2 s).
const STUB_DELAY_MS = 3000;
const SIZE = 64;

// An ellipse of garment on background.
function ellipseMask(): Buffer {
  const mask = Buffer.alloc(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - SIZE / 2) / (SIZE * 0.35);
      const dy = (y - SIZE / 2) / (SIZE * 0.45);
      if (dx * dx + dy * dy <= 1) mask[y * SIZE + x] = 255;
    }
  }
  return mask;
}

const stubRunner: CutoutRunner = {
  inputSize: SIZE,
  async mask() {
    await new Promise((done) => setTimeout(done, STUB_DELAY_MS));
    return { mask: ellipseMask(), inferenceMs: STUB_DELAY_MS };
  },
  close: () => Promise.resolve(),
};

async function main(): Promise<void> {
  // The build, not src/: the tests run what the image ships.
  const { loadConfig } = (await import(
    join(DIST, 'config.js')
  )) as typeof ConfigModule;
  const { createLogger } = (await import(
    join(DIST, 'logger.js')
  )) as typeof LoggerModule;
  const { serve } = (await import(
    join(DIST, 'server.js')
  )) as typeof ServerModule;
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info(
    `Test server: background removal stubbed (${STUB_DELAY_MS} ms a photo)`,
  );
  await serve(config, logger, stubRunner);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
