import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';
import type { CutoutModel } from './model';
import type { ChildReply, ChildRequest } from './protocol';

/** A mask for one image, and what making it cost. */
export interface CutoutMask {
  /** inputSize x inputSize alpha, 0 (background) to 255 (garment). */
  mask: Buffer;
  inferenceMs: number;
  /** The model process's resident and peak memory, when a process ran it. */
  rssMb?: number;
  maxRssMb?: number;
}

/**
 * What the queue (queue.ts) asks of a model: the real one is ModelRunner;
 * the tests inject a fake that returns a mask.
 */
export interface CutoutRunner {
  /** The square side, in pixels, of the RGB image mask() takes. */
  readonly inputSize: number;
  /** `rgb`: inputSize x inputSize RGB, 3 bytes a pixel. One call at a time. */
  mask(rgb: Buffer): Promise<CutoutMask>;
  /** Stops whatever the runner holds (the model process). */
  close(): Promise<void>;
}

/** A job exceeded the hard limit and its model process was killed. */
export class CutoutTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Background removal timed out after ${timeoutMs / 1000} s`);
    this.name = 'CutoutTimeoutError';
  }
}

export const CUTOUT_TIMEOUT_MS = 60_000;
export const MODEL_IDLE_MS = 15 * 60_000;

export interface ModelRunnerOptions {
  model: Pick<CutoutModel, 'ready' | 'spec'>;
  /** onnxruntime intra-op threads (CUTOUT_THREADS). */
  threads: number;
  logger: Logger;
  /** Per mask, the model load included; the download is not. */
  timeoutMs?: number;
  /** Unused this long, the model process exits and its memory goes back. */
  idleMs?: number;
  /** The model process's script; the tests substitute fakes. */
  childPath?: string;
}

// dist/cutout/child.js in the image; child.ts when running from src/ (the
// tests), which Node 22.18+ runs with its built-in type stripping (and
// warns that the file's module type is guessed).
function defaultChild(): { path: string; execArgv: string[] } {
  const built = join(__dirname, 'child.js');
  return existsSync(built)
    ? { path: built, execArgv: [] }
    : {
        path: join(__dirname, 'child.ts'),
        execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
      };
}

interface InFlight {
  id: number;
  child: ChildProcess;
  resolve: (mask: CutoutMask) => void;
  reject: (error: Error) => void;
}

/**
 * Runs the model in a child process (child.ts), started on first use and
 * kept loaded between jobs: one request at a time, a hard timeout per
 * request (the process is killed and the next request starts a fresh one),
 * and unloaded (the process exits) after MODEL_IDLE_MS without work. The
 * model file is verified or downloaded first (CutoutModel.ready), outside
 * the timeout.
 */
export class ModelRunner implements CutoutRunner {
  private child: ChildProcess | undefined;
  private inFlight: InFlight | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  // Why we stopped a process, so its exit is logged as expected.
  private readonly stopReasons = new WeakMap<ChildProcess, string>();
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly childScript: { path: string; execArgv: string[] };

  constructor(private readonly options: ModelRunnerOptions) {
    this.timeoutMs = options.timeoutMs ?? CUTOUT_TIMEOUT_MS;
    this.idleMs = options.idleMs ?? MODEL_IDLE_MS;
    this.childScript = options.childPath
      ? { path: options.childPath, execArgv: [] }
      : defaultChild();
  }

  get inputSize(): number {
    return this.options.model.spec.inputSize;
  }

  async mask(rgb: Buffer): Promise<CutoutMask> {
    const modelPath = await this.options.model.ready();
    clearTimeout(this.idleTimer);
    const child = this.child ?? this.spawn(modelPath);
    try {
      return await this.request(child, rgb);
    } finally {
      this.armIdle();
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    if (this.child) await this.stop(this.child, 'shutdown');
  }

  private spawn(modelPath: string): ChildProcess {
    const { logger, model, threads } = this.options;
    const child = fork(this.childScript.path, [], {
      serialization: 'advanced',
      // Never the parent's flags (a test runner's loaders, --inspect ports).
      execArgv: this.childScript.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    logger.info(
      `Model process ${child.pid} started (${model.spec.name}, ${threads} threads)`,
    );
    child.on('message', (reply: ChildReply) => this.onReply(child, reply));
    child.on('error', (error) => {
      logger.error({ err: error }, `Model process ${child.pid} failed`);
      this.settle(child, error);
    });
    child.on('exit', (code, signal) => {
      const how = signal ?? `code ${code}`;
      const reason = this.stopReasons.get(child);
      if (reason) {
        logger.info(`Model process ${child.pid} exited (${reason})`);
      } else {
        logger.warn(`Model process ${child.pid} exited unexpectedly (${how})`);
      }
      this.settle(child, new Error(`Model process exited (${how})`));
      if (this.child === child) this.child = undefined;
    });
    this.send(child, {
      type: 'load',
      modelPath,
      threads,
      inputSize: model.spec.inputSize,
      mean: model.spec.mean,
      std: model.spec.std,
    });
    return child;
  }

  private request(child: ChildProcess, rgb: Buffer): Promise<CutoutMask> {
    const id = this.nextId++;
    return new Promise<CutoutMask>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.options.logger.warn(
          `Model process ${child.pid} timed out after ${this.timeoutMs} ms; killing it`,
        );
        this.settle(child, new CutoutTimeoutError(this.timeoutMs));
        this.detach(child, 'timed out');
        child.kill('SIGKILL');
      }, this.timeoutMs);
      this.inFlight = {
        id,
        child,
        resolve: (mask) => {
          clearTimeout(timer);
          resolve(mask);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.send(child, { type: 'run', id, rgb });
    });
  }

  private onReply(child: ChildProcess, reply: ChildReply): void {
    const { logger } = this.options;
    switch (reply.type) {
      case 'loaded':
        logger.info(
          `Model process ${child.pid} loaded the model in ${reply.loadMs} ms (RSS ${reply.rssMb} MB)`,
        );
        return;
      case 'mask':
        if (this.inFlight?.id !== reply.id) return;
        this.inFlight.resolve({
          mask: Buffer.from(
            reply.mask.buffer,
            reply.mask.byteOffset,
            reply.mask.byteLength,
          ),
          inferenceMs: reply.inferenceMs,
          rssMb: reply.rssMb,
          maxRssMb: reply.maxRssMb,
        });
        this.inFlight = undefined;
        return;
      case 'error':
        logger.error(`Model process ${child.pid}: ${reply.message}`);
        this.settle(child, new Error(`Model: ${reply.message}`));
        // A failed load leaves a process that can never answer.
        if (reply.id === undefined) void this.stop(child, 'model load failed');
        return;
    }
  }

  // Fails the request in flight on `child`, if any.
  private settle(child: ChildProcess, error: Error): void {
    if (this.inFlight?.child !== child) return;
    const { reject } = this.inFlight;
    this.inFlight = undefined;
    reject(error);
  }

  private send(child: ChildProcess, message: ChildRequest): void {
    child.send(message, (error) => {
      if (error) this.settle(child, error);
    });
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.child) return;
    const child = this.child;
    this.idleTimer = setTimeout(() => {
      void this.stop(child, `idle for ${Math.round(this.idleMs / 60_000)} min`);
    }, this.idleMs);
    // Never what keeps the server alive.
    this.idleTimer.unref();
  }

  // No new request goes to `child` from here on; its exit is expected.
  private detach(child: ChildProcess, reason: string): void {
    this.stopReasons.set(child, reason);
    if (this.child === child) this.child = undefined;
  }

  private async stop(child: ChildProcess, reason: string): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.detach(child, reason);
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    this.options.logger.info(`Stopping model process ${child.pid} (${reason})`);
    child.kill('SIGTERM');
    await exited;
  }
}
