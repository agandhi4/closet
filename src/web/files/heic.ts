import type { MultipartFile } from '@fastify/multipart';
import heicDecode from 'heic-decode';
import { Readable } from 'node:stream';
import { HttpError } from '../errors';

// sharp's bundled libvips has no HEIC decoder, so iPhone photos (and the
// HEIC option on Android) are decoded here first and handed to sharp as raw
// RGBA pixels. heic-decode needs the whole container in memory, hence the
// byte cap; its pixels are allocated only after the dimensions are checked
// against the pixel limit sharp applies to every other upload.
//
// Orientation: libheif applies the container's own rotation/mirror
// transforms (irot/imir, which is how iPhones record orientation) while
// decoding, so the pixels are already upright and carry no EXIF for
// sharp's autoOrient() to act on. Stored as decoded.

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTENSION = /\.hei[cf]$/i;

/** Decoded pixels and the layout sharp needs to read them (`sharp({ raw })`). */
export interface DecodedHeic {
  pixels: Readable;
  raw: { width: number; height: number; channels: 4 };
}

/** An upload with more pixels than Photos accepts, whatever its format. */
export function imageTooLarge(): HttpError {
  return new HttpError(400, 'Image too large');
}

/**
 * Android and desktop browsers sometimes send a HEIC with no better type
 * than application/octet-stream; the file name is the only hint then.
 */
export function isHeicUpload({ mimetype, filename }: MultipartFile): boolean {
  if (HEIC_MIME_TYPES.has(mimetype)) return true;
  return (
    mimetype === 'application/octet-stream' && HEIC_EXTENSION.test(filename)
  );
}

/**
 * Buffers the part up to `maxBytes` and decodes its primary image. Rejects
 * with a 413 HttpError past the byte cap, and with imageTooLarge() past
 * `maxPixels` before any pixel is allocated (a small file can declare a
 * 20000x20000 grid); whatever heic-decode throws for undecodable bytes is
 * passed through for the caller to map to a client error. The part is fully
 * drained on every path: an unconsumed multipart stream hangs the request
 * (see Photos.storeUpload).
 */
export async function decodeHeic(
  part: MultipartFile,
  maxBytes: number,
  maxPixels: number,
): Promise<DecodedHeic> {
  const buffer = await readUpTo(part.file, maxBytes);
  if (!buffer) {
    throw new HttpError(413, `HEIC uploads are limited to ${maxBytes} bytes`);
  }
  const images = await heicDecode.all({ buffer });
  try {
    // The primary image, as heic-decode's default export picks it.
    const [primary] = images;
    if (primary.width * primary.height > maxPixels) throw imageTooLarge();
    const { width, height, data } = await primary.decode();
    return {
      pixels: Readable.from(
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      ),
      raw: { width, height, channels: 4 },
    };
  } finally {
    images.dispose();
  }
}

// undefined when the stream exceeds the cap. The loop never breaks early:
// leaving a for-await destroys the stream, and busboy must see the part end.
async function readUpTo(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (overflow) continue;
    size += chunk.length;
    if (size > maxBytes) {
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  return overflow ? undefined : Buffer.concat(chunks);
}
