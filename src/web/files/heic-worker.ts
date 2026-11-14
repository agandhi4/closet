import heicDecode from 'heic-decode';
import { parentPort } from 'node:worker_threads';

/**
 * The HEIC decoding thread: started by HeicDecoder (heic-decoder.ts), it
 * decodes one container at a time off the server's event loop (#699). A
 * thread rather than a process (the cutout's model runs in one): libheif is
 * WebAssembly, which `worker.terminate()` interrupts mid-decode, so the
 * decoder's deadline needs no fork and the pixels come back transferred.
 *
 * No imports from src/ at runtime: in the tests this file runs under Node's
 * type stripping, where a relative import would need an extension (as
 * src/cutout/child.ts).
 */

/** One container to decode; at most `maxPixels` may be allocated for it. */
export interface HeicRequest {
  container: Uint8Array;
  maxPixels: number;
}

export type HeicReply =
  | { ok: true; width: number; height: number; pixels: ArrayBuffer }
  | { ok: false; reason: 'too-large' | 'undecodable'; message: string };

// The primary image, as heic-decode's default export picks it, with its
// dimensions checked from the container before any pixel is allocated: a
// few bytes can declare a 20000x20000 grid. libheif's WASM memory is freed
// on every path.
async function decodePrimary({
  container,
  maxPixels,
}: HeicRequest): Promise<HeicReply> {
  const images = await heicDecode.all({ buffer: container });
  try {
    const [primary] = images;
    if (primary.width * primary.height > maxPixels) {
      return {
        ok: false,
        reason: 'too-large',
        message: `${primary.width}x${primary.height} is over ${maxPixels} pixels`,
      };
    }
    const { width, height, data } = await primary.decode();
    // heic-decode allocates `data` itself (a whole buffer of its own), so
    // it is transferred, not copied.
    return { ok: true, width, height, pixels: data.buffer as ArrayBuffer };
  } finally {
    images.dispose();
  }
}

const port = parentPort;
if (!port) throw new Error('heic-worker runs only as a HeicDecoder thread');
port.on('message', (request: HeicRequest) => {
  decodePrimary(request).then(
    (reply) => port.postMessage(reply, reply.ok ? [reply.pixels] : []),
    (error: unknown) =>
      port.postMessage({
        ok: false,
        reason: 'undecodable',
        message: error instanceof Error ? error.message : String(error),
      } satisfies HeicReply),
  );
});
