import * as ort from 'onnxruntime-node';
import type { ChildReply, ChildRequest, LoadRequest } from './protocol';

/**
 * The model process: forked by ModelRunner (runner.ts), it holds the one
 * onnxruntime session and answers mask requests over IPC (protocol.ts), one
 * at a time. A process rather than a worker thread because onnxruntime
 * cannot be interrupted mid-run: the parent kills this process on a timeout,
 * gets the memory back when it idles out, and an out-of-memory kill takes
 * this process, not the server.
 *
 * No imports from src/ at runtime: see protocol.ts.
 */

interface Loaded {
  session: ort.InferenceSession;
  config: LoadRequest;
}

let loaded: Promise<Loaded> | undefined;
// Requests are handled strictly in order (the parent sends one at a time;
// this keeps a load and the first run from overlapping).
let queue: Promise<void> = Promise.resolve();

const megabytes = (bytes: number) => Math.round(bytes / 1048576);
const rssMb = () => megabytes(process.memoryUsage().rss);
// resourceUsage().maxRSS is in kilobytes.
const maxRssMb = () => Math.round(process.resourceUsage().maxRSS / 1024);

function reply(message: ChildReply): void {
  process.send?.(message);
}

async function load(config: LoadRequest): Promise<Loaded> {
  const startedAt = performance.now();
  const session = await ort.InferenceSession.create(config.modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: config.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    // Off: with the arena on, the ~1 GB of activations of a run stay
    // allocated between runs instead of going back to the system.
    enableCpuMemArena: false,
  });
  reply({
    type: 'loaded',
    loadMs: Math.round(performance.now() - startedAt),
    rssMb: rssMb(),
  });
  return { session, config };
}

// RGB bytes, interleaved, to the normalised planar float tensor the model
// takes (NCHW).
function toTensor(rgb: Uint8Array, config: LoadRequest): ort.Tensor {
  const size = config.inputSize;
  const plane = size * size;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      data[c * plane + i] =
        (rgb[i * 3 + c] / 255 - config.mean[c]) / config.std[c];
    }
  }
  return new ort.Tensor('float32', data, [1, 3, size, size]);
}

// The model's logits through a sigmoid to 0-255 alpha.
function toMask(logits: Float32Array): Uint8Array {
  const mask = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    mask[i] = Math.round(255 / (1 + Math.exp(-logits[i])));
  }
  return mask;
}

async function run(id: number, rgb: Uint8Array): Promise<void> {
  if (!loaded) throw new Error('Run before load');
  const { session, config } = await loaded;
  const startedAt = performance.now();
  const outputs = await session.run({
    [session.inputNames[0]]: toTensor(rgb, config),
  });
  const logits = outputs[session.outputNames[0]].data as Float32Array;
  const mask = toMask(logits);
  reply({
    type: 'mask',
    id,
    mask,
    inferenceMs: Math.round(performance.now() - startedAt),
    rssMb: rssMb(),
    maxRssMb: maxRssMb(),
  });
}

async function handle(message: ChildRequest): Promise<void> {
  try {
    if (message.type === 'load') {
      loaded = load(message);
      await loaded;
    } else {
      await run(message.id, message.rgb);
    }
  } catch (error) {
    reply({
      type: 'error',
      id: message.type === 'run' ? message.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

process.on('message', (message: ChildRequest) => {
  queue = queue.then(() => handle(message));
});
// The parent closed the channel (idle unload, shutdown) or died: nothing
// left to answer.
process.on('disconnect', () => process.exit(0));
