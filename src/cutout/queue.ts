import type { Db, DbConfig } from '../db/client';
import type { Logger } from '../logger';
import type { Photos } from '../web/files/photos';
import { settlesWithin } from './deadline';
import { CutoutListener } from './listener';
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
// How long stop() waits for the runner to close and the job loop to end
// (after the listener's own bounded close). The loop ends within a query
// once stopped; a runner closes in well under a second. Past this, stop()
// returns anyway: a hung shutdown blocks the deploy behind it.
const STOP_TIMEOUT_MS = 10_000;

export interface CutoutQueueDeps {
  db: Db;
  /** The pool's settings, for the listener's own connection. */
  database: DbConfig;
  photos: Photos;
  logger: Logger;
  /** How long an idle queue waits before looking again unasked (CUTOUT_POLL_SECONDS). */
  pollMs: number;
}

/**
 * Server-side background removal, one photo at a time. The database is the
 * queue: `file` rows whose cutout is pending (src/cutout/state.ts), oldest
 * request first, so a restart loses nothing (pending rows are picked up at
 * start) and nothing is held in memory. Built by createApp() for every app
 * but started only by server.ts, with the model runner; the integration
 * specs start it with a fake one. Stopped by the app's onClose.
 *
 * It looks for work when told to and on its own: wake() from a write in
 * this process; a Postgres notification from a write in any process (the
 * listener, one connection of its own while started); after the listener
 * reconnects (notifications sent meanwhile are lost); and every `pollMs`
 * while idle, the backstop for anything those missed. Two queues on one
 * database (an overlapping deploy) both hear every notification; the claim
 * skips rows locked by the other's claim, but a job stays pending while it
 * runs, so both may run one photo and the state machine keeps one result
 * (claimNextCutout).
 */
export class CutoutQueue {
  private runner: CutoutRunner | undefined;
  private listener: CutoutListener | undefined;
  private loop: Promise<void> | undefined;
  // Aborted by stop(). One per start(), so a loop still ending when stop()
  // gave up on it can never be revived by the next start().
  private halt: AbortController | undefined;
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
    const halt = new AbortController();
    this.halt = halt;
    this.deps.logger.info(
      `Cutout queue started; resuming pending cutouts, polling every ${this.deps.pollMs / 1000} s while idle`,
    );
    this.listener = new CutoutListener({
      database: this.deps.database,
      logger: this.deps.logger,
      wake: () => this.wake(),
    });
    this.listener.start();
    this.loop = this.run(runner, halt.signal);
  }

  /**
   * A row became pending: look now. A no-op while the queue is not running.
   * Called by this process's writes and by the listener.
   */
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
   * Stops the listener, the loop and the runner. Always resolves, within the
   * listener's close timeout plus STOP_TIMEOUT_MS however they hang, and
   * never rejects. A job cut short stays pending, so the next start runs it
   * again.
   */
  async stop(): Promise<void> {
    const runner = this.runner;
    if (!runner) return;
    const { logger } = this.deps;
    const startedAt = Date.now();
    const listener = this.listener;
    const loop = this.loop;
    this.halt?.abort();
    this.halt = undefined;
    this.listener = undefined;
    this.loop = undefined;
    await listener?.close();
    // Never rejects: a failed close is logged, and the app's onClose still
    // ends the pool after it (an open pool keeps the process alive).
    const closeRunner = runner.close().catch((error: unknown) => {
      logger.error({ err: error }, 'Cutout runner failed to close');
    });
    const ended = await settlesWithin(
      closeRunner.then(() => loop),
      STOP_TIMEOUT_MS,
    );
    if (!ended) {
      logger.warn(
        `Cutout queue gave up waiting for its runner and job loop after ${STOP_TIMEOUT_MS / 1000} s; a job still running stays pending`,
      );
    }
    this.runner = undefined;
    logger.info(`Cutout queue stopped in ${Date.now() - startedAt} ms`);
  }

  private async run(runner: CutoutRunner, halt: AbortSignal): Promise<void> {
    const { db, logger, pollMs } = this.deps;
    // Whether this look is the idle poll's rather than a wake's.
    let polling = false;
    while (!halt.aborted) {
      this.woken = false;
      let job: CutoutJob | undefined;
      try {
        job = await claimNextCutout(db);
      } catch (error) {
        logger.error(
          { err: error },
          `Could not read the cutout queue; trying again in ${CLAIM_RETRY_MS / 1000} s`,
        );
        await this.sleep(CLAIM_RETRY_MS, halt);
        continue;
      }
      if (job) {
        if (polling) {
          // Nothing told this server about the row: a notification was lost
          // or the listener was down. Worth seeing if it keeps happening.
          logger.info(
            `Cutout poll found photo ${job.fileId} (${job.fileName.slice(0, 8)}) pending without a notification`,
          );
        }
        polling = false;
        await this.process(job, runner, halt);
        continue;
      }
      this.settleIdle();
      polling = !this.woken && (await this.sleep(pollMs, halt)) === 'timeout';
    }
    this.settleIdle();
  }

  private async process(
    job: CutoutJob,
    runner: CutoutRunner,
    halt: AbortSignal,
  ): Promise<void> {
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
      if (halt.aborted) {
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

  // Waits `ms`, or less when woken or halted: which one ended it. Halted
  // before it began, it does not wait at all: stop() often lands while the
  // loop awaits a claim, when there is no sleep yet to cut short, and the
  // loop checks `halt` only at its top (that lost wake-up hung stop() for
  // the whole poll interval).
  private sleep(
    ms: number,
    halt: AbortSignal,
  ): Promise<'timeout' | 'woken' | 'halted'> {
    if (halt.aborted) return Promise.resolve('halted');
    return new Promise((resolve) => {
      const end = (outcome: 'timeout' | 'woken' | 'halted') => {
        clearTimeout(timer);
        halt.removeEventListener('abort', onHalt);
        if (this.wakeUp === onWake) this.wakeUp = undefined;
        resolve(outcome);
      };
      const timer = setTimeout(() => end('timeout'), ms);
      const onHalt = () => end('halted');
      const onWake = () => end('woken');
      halt.addEventListener('abort', onHalt);
      this.wakeUp = onWake;
    });
  }

  private settleIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * The nightly retry (server.ts): every failed cutout below
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
