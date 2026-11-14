import type { Config } from '../config';
import type { Logger } from '../logger';
import { BIREFNET_512, CutoutModel } from './model';
import { ModelRunner } from './runner';

/**
 * The background-removal model's runner for main.ts, or undefined with
 * CUTOUT_ENABLED=false: then no CutoutModel exists, so nothing is verified
 * or downloaded (940 MB) and no model process is ever forked. With it, the
 * model file is verified (or downloaded) now, at boot, rather than at the
 * first upload; the process that runs it starts with the first job.
 */
export function bootModelRunner(
  config: Config,
  logger: Logger,
): ModelRunner | undefined {
  if (!config.CUTOUT_ENABLED) return undefined;
  const log = logger.child({ logger: 'Cutout' });
  log.info(
    `Background removal: model in ${config.MODELS_PATH}, ${config.CUTOUT_THREADS} threads`,
  );
  const model = new CutoutModel(
    BIREFNET_512,
    config.MODELS_PATH,
    logger.child({ logger: 'CutoutModel' }),
  );
  // Logged by CutoutModel; the first job tries again if this failed.
  model.ready().catch(() => undefined);
  return new ModelRunner({
    model,
    threads: config.CUTOUT_THREADS,
    logger: log,
  });
}
