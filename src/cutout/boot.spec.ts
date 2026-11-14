import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { bootModelRunner } from './boot';
import { CutoutModel } from './model';

vi.mock('./model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model')>()),
  CutoutModel: vi.fn(
    class {
      spec = {};
      ready = vi.fn(() => Promise.resolve(''));
    },
  ),
}));

const logger = { child: () => logger, info: vi.fn() } as unknown as Logger;

describe('bootModelRunner', () => {
  it('builds no model, so fetches nothing, with CUTOUT_ENABLED=false', () => {
    const config = { CUTOUT_ENABLED: false } as Config;
    expect(bootModelRunner(config, logger)).toBeUndefined();
    expect(CutoutModel).not.toHaveBeenCalled();
  });

  it('builds the model, which starts its verify or download, when enabled', () => {
    const config = {
      CUTOUT_ENABLED: true,
      MODELS_PATH: '/models',
      CUTOUT_THREADS: 2,
    } as Config;
    expect(bootModelRunner(config, logger)).toBeDefined();
    expect(CutoutModel).toHaveBeenCalledTimes(1);
  });
});
