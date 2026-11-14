import { ModelChecksumError, ModelDownloadError } from './model';
import { ModelBindingError } from './runner';

/**
 * The cutout queue's own state (#689), as opposed to a photo's cutout state
 * (state.ts): whether it is started, and whether it can run the model.
 * `queueTransition` is the one place that moves it; CutoutQueue holds the
 * state and acts on what each transition answers (a log line, a capture).
 *
 *   stopped -> running            start
 *   running -> waiting-for-model  model-unavailable (captured)
 *   waiting-for-model -> itself   model-unavailable (captured only for a
 *                                 kind not yet seen in this outage)
 *   waiting-for-model -> running  model-ready (the outage ends; the queue
 *                                 drains what waited, without a restart)
 *   any -> stopped                stop
 *
 * A model-ready or model-unavailable landing after stop() leaves `stopped`
 * alone: a loop still ending must not revive the state.
 */

/**
 * Why the model cannot be had, from a closed set: /health/ready's
 * cutout_queue `reason` and the error tracker's `kind` tag. Never the
 * error's text, which the unauthenticated body must not carry.
 */
export type ModelUnavailableKind =
  | 'download'
  | 'checksum'
  | 'permission'
  | 'binding'
  | 'other';

export type CutoutQueueState =
  | { name: 'stopped' }
  | { name: 'running' }
  | {
      name: 'waiting-for-model';
      /** The latest failure's kind: what the health check names. */
      kind: ModelUnavailableKind;
      /** Date.now() when the outage began. */
      since: number;
      /** Every kind captured in this outage, so a retry is never captured again. */
      captured: readonly ModelUnavailableKind[];
    };

export type CutoutQueueEvent =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'model-ready' }
  | { type: 'model-unavailable'; kind: ModelUnavailableKind };

export interface QueueTransition {
  state: CutoutQueueState;
  /** A new outage, or a kind this outage had not shown: send it to the error tracker. */
  capture: boolean;
  /** The outage this model-ready ended, in ms; absent when none ended. */
  recoveredAfterMs?: number;
}

export function queueTransition(
  state: CutoutQueueState,
  event: CutoutQueueEvent,
  now: number,
): QueueTransition {
  switch (event.type) {
    case 'start':
      if (state.name !== 'stopped') {
        throw new Error(`The cutout queue cannot start while ${state.name}`);
      }
      return { state: { name: 'running' }, capture: false };
    case 'stop':
      return { state: { name: 'stopped' }, capture: false };
    case 'model-ready':
      if (state.name !== 'waiting-for-model') return { state, capture: false };
      return {
        state: { name: 'running' },
        capture: false,
        recoveredAfterMs: now - state.since,
      };
    case 'model-unavailable':
      return modelUnavailable(state, event.kind, now);
  }
}

// Entering the wait captures; within it, only a kind not yet captured.
function modelUnavailable(
  state: CutoutQueueState,
  kind: ModelUnavailableKind,
  now: number,
): QueueTransition {
  if (state.name === 'stopped') return { state, capture: false };
  const captured = state.name === 'running' ? [] : state.captured;
  const seen = captured.includes(kind);
  return {
    state: {
      name: 'waiting-for-model',
      kind,
      since: state.name === 'running' ? now : state.since,
      captured: seen ? captured : [...captured, kind],
    },
    capture: !seen,
  };
}

// Filesystem refusals of MODELS_PATH: a root-owned mount, a read-only one.
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/** What CutoutRunner.ready()'s rejection says about the model. */
export function modelUnavailableKind(error: unknown): ModelUnavailableKind {
  if (error instanceof ModelChecksumError) return 'checksum';
  if (error instanceof ModelDownloadError) return 'download';
  if (error instanceof ModelBindingError) return 'binding';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && PERMISSION_CODES.has(code)) {
    return 'permission';
  }
  return 'other';
}

/**
 * The operator's step for each kind: cutout_queue's `fix` while the queue
 * waits for the model. Each ends at its section of docs/operations.md.
 */
export const MODEL_UNAVAILABLE_FIX: Record<ModelUnavailableKind, string> = {
  download:
    'the model download was refused or unreachable: check the network to huggingface.co, or run npm run cutout:fetch-model; see docs/operations.md#health',
  checksum:
    'the file in MODELS_PATH is not the pinned model: run npm run cutout:fetch-model to replace it; see docs/operations.md#health',
  permission:
    'MODELS_PATH is not writable by this process: chown it to uid 1000; see docs/operations.md#permissions',
  binding:
    'onnxruntime-node has no native binding for this platform: run the linux/amd64 image; see docs/operations.md#health',
  other: 'the model could not be loaded: see docs/operations.md#health',
};
