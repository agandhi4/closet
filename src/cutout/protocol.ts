/**
 * Messages between ModelRunner (runner.ts) and the model process
 * (child.ts), over the fork() IPC channel with `serialization: 'advanced'`
 * (structured clone), so pixel buffers travel as bytes, not JSON.
 *
 * Types only: child.ts imports them with `import type`, which keeps it free
 * of runtime imports from src/ (it also runs as TypeScript under Node's type
 * stripping in the tests, where relative imports would need extensions).
 */

/** Sent once, first: load the model into an onnxruntime CPU session. */
export interface LoadRequest {
  type: 'load';
  modelPath: string;
  /** onnxruntime intra-op threads (CUTOUT_THREADS). */
  threads: number;
  /** ModelSpec's input side and normalisation. */
  inputSize: number;
  mean: readonly number[];
  std: readonly number[];
}

/** One image: inputSize x inputSize RGB, 3 bytes a pixel, row-major. */
export interface RunRequest {
  type: 'run';
  id: number;
  rgb: Uint8Array;
}

export type ChildRequest = LoadRequest | RunRequest;

export type ChildReply =
  | { type: 'loaded'; loadMs: number; rssMb: number }
  | {
      type: 'mask';
      id: number;
      /** inputSize x inputSize alpha, 0 (background) to 255 (garment). */
      mask: Uint8Array;
      inferenceMs: number;
      rssMb: number;
      /** The process's peak resident set so far. */
      maxRssMb: number;
    }
  /** `id` is absent when the load failed. */
  | { type: 'error'; id?: number; message: string };
