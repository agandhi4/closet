import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Db, DbConfig } from '../db/client';
import type { Logger } from '../logger';
import type { JobOutcome, Metrics } from '../metrics/metrics';
import type { Photos } from '../web/files/photos';
import { settlesWithin } from './deadline';
import { CutoutListener } from './listener';
import {
  claimNextCutout,
  CUTOUT_LEASE_MS,
  type CutoutJob,
  recordCutoutEvent,
  retryableCutouts,
} from './queries';
import type { CutoutRunner } from './runner';
import { MAX_CUTOUT_ATTEMPTS } from './state';

// After the queue itself could not be read (the database away), look again
// this much later rather than spin.
const CLAIM_RETRY_MS = 30_000;
// After the runner could not ready the model (a download that failed, a
// file that fails its checksum), try again this much later: each try may
// download 940 MB or hash it.
const MODEL_RETRY_MS = 5 * 60_000;
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
  /** Each job's run time and ending, as job_duration_seconds{name="cutout"}. */
  metrics: Metrics;
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
 * database (an overlapping deploy) both hear every notification, but each
 * job holds a lease on its row, so the model runs once per photo across
 * servers (claimNextCutout). Each start() is a worker of its own, named in
 * the lease (cutout_worker: host, pid and a random suffix).
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
    // Per start, not per process: a job a previous start() gave up on may
    // still hold a lease, which this start must not release as its own.
    const worker = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.deps.logger.info(
      `Cutout queue started as worker ${worker}; resuming pending cutouts, polling every ${this.deps.pollMs / 1000} s while idle`,
    );
    this.listener = new CutoutListener({
      database: this.deps.database,
      logger: this.deps.logger,
      wake: () => this.wake(),
    });
    this.listener.start();
    this.loop = this.run(runner, worker, halt.signal);
  }

  /**
   * A row became pending: look now. A no-op while the queue is not running.
   * Called by this process's writes and by the listener.
   */
  wake(): void {
    this.woken = true;
    this.wakeUp?.();
  }

  /**
   * Resolves once the queue has looked, starting after this call, and found
   * nothing it may claim (tests). A look already in flight does not count:
   * it may have started before the spec's last write.
   */
  whenIdle(): Promise<void> {
    const idle = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    this.wake();
    return idle;
  }

  /**
   * Stops the listener, the loop and the runner. Always resolves, within the
   * listener's close timeout plus STOP_TIMEOUT_MS however they hang, and
   * never rejects. A job cut short stays pending and releases its lease, so
   * the next start, or another server, runs it at once. One still running
   * when stop() gives up keeps its lease until it lapses (CUTOUT_LEASE_MS):
   * it may yet finish, and releasing it could let a second run start beside
   * it.
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
        `Cutout queue gave up waiting for its runner and job loop after ${STOP_TIMEOUT_MS / 1000} s; a job still running stays pending, leased for up to ${CUTOUT_LEASE_MS / 60_000} min`,
      );
    }
    this.runner = undefined;
    logger.info(`Cutout queue stopped in ${Date.now() - startedAt} ms`);
  }

  private async run(
    runner: CutoutRunner,
    worker: string,
    halt: AbortSignal,
  ): Promise<void> {
    const { db, logger, pollMs } = this.deps;
    // Whether this look is the idle poll's rather than a wake's.
    let polling = false;
    while (!halt.aborted) {
      this.woken = false;
      if (!(await this.runnerReady(runner, halt))) continue;
      // The whenIdle() callers this look answers: those who asked before it.
      const asked = this.idleWaiters.length;
      let job: CutoutJob | undefined;
      try {
        job = await claimNextCutout(db, worker);
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
        const startedAt = performance.now();
        const outcome = await this.process(job, runner, worker, halt);
        this.deps.metrics.observeJob(
          'cutout',
          outcome,
          (performance.now() - startedAt) / 1000,
        );
        continue;
      }
      this.settleIdle(asked);
      polling = !this.woken && (await this.sleep(pollMs, halt)) === 'timeout';
    }
    this.settleIdle(this.idleWaiters.length);
  }

  // Waits for the runner's model before any claim, so no lease is held
  // through a download. False when halted, or when it failed (after waiting
  // MODEL_RETRY_MS): pending rows wait for the model rather than fail
  // without it. The model logs why; this logs that the queue waits.
  private async runnerReady(
    runner: CutoutRunner,
    halt: AbortSignal,
  ): Promise<boolean> {
    if (halt.aborted) return false;
    let onHalt!: () => void;
    const halted = new Promise<'halted'>((resolve) => {
      onHalt = () => resolve('halted');
      halt.addEventListener('abort', onHalt);
    });
    try {
      return (await Promise.race([runner.ready(), halted])) !== 'halted';
    } catch (error) {
      this.deps.logger.warn(
        `Cutout queue cannot run the model (${error instanceof Error ? error.message : String(error)}); pending cutouts wait, trying again in ${MODEL_RETRY_MS / 60_000} min`,
      );
    } finally {
      halt.removeEventListener('abort', onHalt);
    }
    await this.sleep(MODEL_RETRY_MS, halt);
    return false;
  }

  // Answers how the job ended, for its metric.
  private async process(
    job: CutoutJob,
    runner: CutoutRunner,
    worker: string,
    halt: AbortSignal,
  ): Promise<JobOutcome> {
    const { photos, logger } = this.deps;
    const startedAt = Date.now();
    const queuedMs =
      job.requestedAt === null ? 0 : startedAt - job.requestedAt.getTime();
    const label = `garment ${job.garmentId ?? '-'} photo ${job.fileId} (${job.fileName.slice(0, 8)})`;
    if (job.lapsedWorker !== null) {
      // Its server crashed or hung mid-job: that photo waited a whole lease.
      logger.warn(
        `Cutout lease of worker ${job.lapsedWorker} lapsed after ${CUTOUT_LEASE_MS / 60_000} min; running ${label} again`,
      );
    }
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
        return 'success';
      }
      // The photo was edited, replaced or requeued while the job ran.
      const lease =
        outcome.reason === 'stale'
          ? `; ${await this.release(job, label, worker)}`
          : '';
      logger.info(
        `Cutout discarded (${outcome.reason}): ${label}; ${timing}${lease}`,
      );
      return 'discarded';
    } catch (error) {
      if (halt.aborted) {
        logger.info(
          `Cutout interrupted by shutdown: ${label}; stays pending, ${await this.release(job, label, worker)}`,
        );
        return 'interrupted';
      }
      return this.fail(job, label, worker, startedAt, error);
    }
  }

  // Gives the row back when a job ends without a result that clears its
  // lease: cut short by stop() (it has ended here, so no second run can
  // start beside it, and the next server need not wait out the lease), or
  // refused as stale while the row stays pending (it would sit leased for
  // nothing). Every other ending already cleared it. The machine releases
  // only this worker's own lease. Answers what happened, for the caller's
  // log line. During stop() the pool is still open: the app ends it after.
  private async release(
    job: CutoutJob,
    label: string,
    worker: string,
  ): Promise<string> {
    const { db, logger } = this.deps;
    const lapses = `its lease lapses in ${CUTOUT_LEASE_MS / 60_000} min`;
    try {
      const outcome = await recordCutoutEvent(db, job.fileName, {
        type: 'release',
        worker,
      });
      if (outcome.ok) return 'lease released';
      switch (outcome.reason) {
        case 'stale':
          return "its lease is another worker's now";
        case 'not-allowed':
          return 'no lease left to release';
        case 'gone':
          return 'the photo is gone';
      }
    } catch (error) {
      logger.error(
        { err: error },
        `Could not release the lease on ${label}; ${lapses}`,
      );
      return lapses;
    }
  }

  // Records `fail` for the job's photo version. A photo deleted or replaced
  // under the job (its original gone before the result was composed) is
  // not a failure: the job is simply discarded.
  private async fail(
    job: CutoutJob,
    label: string,
    worker: string,
    startedAt: number,
    error: unknown,
  ): Promise<JobOutcome> {
    const { db, logger } = this.deps;
    const elapsed = `after ${Date.now() - startedAt} ms`;
    try {
      const outcome = await recordCutoutEvent(db, job.fileName, {
        type: 'fail',
        jobVersion: job.jobVersion,
      });
      if (!outcome.ok && outcome.reason === 'gone') {
        logger.info(`Cutout discarded (gone): ${label}, ${elapsed}`);
        return 'discarded';
      }
      let recorded = '';
      if (!outcome.ok) {
        const lease =
          outcome.reason === 'stale'
            ? `; ${await this.release(job, label, worker)}`
            : '';
        recorded = ` (not recorded: ${outcome.reason}${lease})`;
      }
      logger.error(
        { err: error },
        `Cutout failed: ${label}, attempt ${job.attempts}, ${elapsed}${recorded}`,
      );
    } catch (recordError) {
      // The row stays pending, leased: it runs again once the lease lapses.
      logger.error(
        { err: error },
        `Cutout failed: ${label}, attempt ${job.attempts}, ${elapsed}`,
      );
      logger.error(
        { err: recordError },
        `Could not record failure of ${label}`,
      );
    }
    return 'failure';
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

  // Resolves the first `count` whenIdle() callers. Later ones asked while
  // the look was in flight; their wake() makes the loop look again for them.
  private settleIdle(count: number): void {
    for (const resolve of this.idleWaiters.splice(0, count)) resolve();
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
