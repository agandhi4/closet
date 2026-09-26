import type { Db } from '../db/client';
import type { Logger } from '../logger';
import type { Photos } from '../web/files/photos';
import {
  claimNextCutout,
  type CutoutJob,
  recordCutoutEvent,
  retryableCutouts,
} from './queries';
import type { CutoutRunner } from './runner';
import { MAX_CUTOUT_ATTEMPTS } from './state';

// After the queue itself could not be read (the database away), look again
// this much later rather than spin.
const CLAIM_RETRY_MS = 30_000;

export interface CutoutQueueDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
}

/**
 * Server-side background removal, one photo at a time. The database is the
 * queue: `file` rows whose cutout is pending (src/cutout/state.ts), oldest
 * request first, so a restart loses nothing (pending rows are picked up at
 * start) and nothing is held in memory. Built by createApp() for every app
 * but started only by main.ts in CUTOUT_MODE=server, with the model runner;
 * the integration specs start it with a fake one. Stopped by the app's
 * onClose.
 */
export class CutoutQueue {
  private runner: CutoutRunner | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  // Set by wake(); the loop looks again before waiting when it is set, so a
  // wake that lands while a claim is in flight is never lost.
  private woken = false;
  private wakeUp: (() => void) | undefined;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly deps: CutoutQueueDeps) {}

  /** Starts working through pending rows with `runner`. */
  start(runner: CutoutRunner): void {
    if (this.runner) throw new Error('The cutout queue is already running');
    this.runner = runner;
    this.stopping = false;
    this.deps.logger.info('Cutout queue started; resuming pending cutouts');
    this.loop = this.run(runner);
  }

  /** A row became pending: look now. A no-op while the queue is not running. */
  wake(): void {
    this.woken = true;
    this.wakeUp?.();
  }

  /** Resolves once the queue has looked and found nothing pending (tests). */
  whenIdle(): Promise<void> {
    const idle = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    this.wake();
    return idle;
  }

  /**
   * Stops the loop and the runner. A job cut short stays pending, so the
   * next start runs it again.
   */
  async stop(): Promise<void> {
    const runner = this.runner;
    if (!runner) return;
    this.stopping = true;
    this.wakeUp?.();
    await runner.close();
    await this.loop;
    this.runner = undefined;
    this.deps.logger.info('Cutout queue stopped');
  }

  private async run(runner: CutoutRunner): Promise<void> {
    while (!this.stopping) {
      this.woken = false;
      let job: CutoutJob | undefined;
      try {
        job = await claimNextCutout(this.deps.db);
      } catch (error) {
        this.deps.logger.error(
          { err: error },
          `Could not read the cutout queue; trying again in ${CLAIM_RETRY_MS / 1000} s`,
        );
        await this.sleep(CLAIM_RETRY_MS);
        continue;
      }
      if (job) {
        await this.process(job, runner);
        continue;
      }
      this.settleIdle();
      if (!this.woken) await this.sleep();
    }
    this.settleIdle();
  }

  private async process(job: CutoutJob, runner: CutoutRunner): Promise<void> {
    const { photos, logger } = this.deps;
    const startedAt = Date.now();
    const queuedMs =
      job.requestedAt === null ? 0 : startedAt - job.requestedAt.getTime();
    const label = `garment ${job.garmentId ?? '-'} photo ${job.fileId} (${job.fileName.slice(0, 8)})`;
    logger.info(
      `Cutout started: ${label}, attempt ${job.attempts}, queued ${queuedMs} ms`,
    );
    try {
      const rgb = await photos.cutoutInput(job.fileName, runner.inputSize);
      const result = await runner.mask(rgb);
      const outcome = await photos.saveModelCutout(
        job.fileName,
        result.mask,
        runner.inputSize,
        job.jobVersion,
      );
      const memory =
        result.maxRssMb === undefined
          ? ''
          : `, model process RSS ${result.rssMb} MB (peak ${result.maxRssMb} MB)`;
      const timing = `queue wait ${queuedMs} ms, inference ${result.inferenceMs} ms, total ${Date.now() - startedAt} ms${memory}`;
      if (outcome.ok) {
        logger.info(
          `Cutout ready: ${label}, version ${outcome.state.version}; ${timing}`,
        );
      } else {
        // The photo was edited, replaced or requeued while the job ran.
        logger.info(
          `Cutout discarded (${outcome.reason}): ${label}; ${timing}`,
        );
      }
    } catch (error) {
      if (this.stopping) {
        logger.info(`Cutout interrupted by shutdown: ${label}; stays pending`);
        return;
      }
      await this.fail(job, label, startedAt, error);
    }
  }

  // Records `fail` for the job's photo version. A photo deleted or replaced
  // under the job (its original gone before the result was composed) is
  // not a failure: the job is simply discarded.
  private async fail(
    job: CutoutJob,
    label: string,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    const { db, logger } = this.deps;
    const elapsed = `after ${Date.now() - startedAt} ms`;
    try {
      const outcome = await recordCutoutEvent(db, job.fileName, {
        type: 'fail',
        jobVersion: job.jobVersion,
      });
      if (!outcome.ok && outcome.reason === 'gone') {
        logger.info(`Cutout discarded (gone): ${label}, ${elapsed}`);
        return;
      }
      logger.error(
        { err: error },
        `Cutout failed: ${label}, attempt ${job.attempts}, ${elapsed}${outcome.ok ? '' : ` (not recorded: ${outcome.reason})`}`,
      );
    } catch (recordError) {
      // The row stays pending and runs again on the next look or start.
      logger.error(
        { err: error },
        `Cutout failed: ${label}, attempt ${job.attempts}, ${elapsed}`,
      );
      logger.error(
        { err: recordError },
        `Could not record failure of ${label}`,
      );
    }
  }

  private sleep(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = () => {
        this.wakeUp = undefined;
        done();
      };
    });
  }

  private settleIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * The nightly retry (main.ts, server mode): every failed cutout below
 * MAX_CUTOUT_ATTEMPTS runs is requeued (`retry`). Returns how many were;
 * the caller wakes the queue.
 */
export async function retryFailedCutouts(
  db: Db,
  logger: Logger,
): Promise<number> {
  const fileNames = await retryableCutouts(db, MAX_CUTOUT_ATTEMPTS);
  let requeued = 0;
  for (const fileName of fileNames) {
    const outcome = await recordCutoutEvent(db, fileName, { type: 'retry' });
    if (outcome.ok) requeued += 1;
  }
  logger.info(
    `Cutout retry: requeued ${requeued} of ${fileNames.length} failed cutout(s) under ${MAX_CUTOUT_ATTEMPTS} attempts`,
  );
  return requeued;
}
