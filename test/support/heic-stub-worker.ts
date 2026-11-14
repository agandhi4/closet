import { parentPort } from 'node:worker_threads';

/**
 * A stand-in for src/web/files/heic-worker.ts (HeicDecoderOptions.workerPath):
 * the container's bytes, read as text, say what the thread does, so a spec
 * steers each decode by what it uploads.
 *
 * - `block:<ms>`: blocks this thread (never the server's) that long, then
 *   answers 2x2 pixels: a large decode, deterministically.
 * - `hang`: never answers (the deadline's case).
 * - `crash`: ends the thread mid-decode.
 * - `oom`: fills the thread's heap past its resourceLimits.
 * - anything else: 2x2 pixels at once.
 *
 * Runs under Node's type stripping: node: imports only (heic-worker.ts).
 */

interface StubRequest {
  container: Uint8Array;
}

const port = parentPort;
if (!port)
  throw new Error('heic-stub-worker runs only as a HeicDecoder thread');

function answerPixels(target: NonNullable<typeof parentPort>): void {
  const pixels = new Uint8ClampedArray(2 * 2 * 4).fill(128);
  target.postMessage({ ok: true, width: 2, height: 2, pixels: pixels.buffer }, [
    pixels.buffer,
  ]);
}

port.on('message', ({ container }: StubRequest) => {
  const command = Buffer.from(container).toString('utf8');
  if (command === 'hang') return;
  if (command === 'crash') process.exit(3);
  if (command === 'oom') {
    const hog: number[][] = [];
    for (;;) hog.push(new Array<number>(1_000_000).fill(1));
  }
  const blockMs = /^block:(\d+)$/.exec(command)?.[1];
  if (blockMs) {
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Number(blockMs),
    );
  }
  answerPixels(port);
});
