import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { CutoutRunner } from '../../src/cutout/runner';
import { createLogger } from '../../src/logger';

/**
 * The server test/cutout-server.spec.ts drives (playwright.config.ts starts
 * it on :3001 beside the real build on :3000): the app from src/ in
 * CUTOUT_MODE=server with the model replaced by a stub, so a browser can
 * watch an upload go pending and its cutout arrive without the 940 MB
 * model. Same database and configuration as the :3000 server otherwise.
 */

const STUB_PORT = 3001;

// Long enough that the page after the upload always sees the cutout
// pending and polls at least once.
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
    await new Promise((resolve) => setTimeout(resolve, STUB_DELAY_MS));
    return { mask: ellipseMask(), inferenceMs: STUB_DELAY_MS };
  },
  close: () => Promise.resolve(),
};

async function main(): Promise<void> {
  const config = loadConfig({
    env: { ...process.env, CUTOUT_MODE: 'server', PORT: String(STUB_PORT) },
  });
  const logger = createLogger(config);
  const { app, cutouts } = await createApp(config, logger);
  cutouts.start(stubRunner);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void app.close());
  }
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
