import { MultipartFile } from '@fastify/multipart';
import { PayloadTooLargeException } from '@nestjs/common';
import heicConvert from 'heic-convert';
import { Readable } from 'stream';

// sharp's bundled libvips has no HEIC decoder, so iPhone photos (and the
// HEIC option on Android) are decoded here first and handed to sharp as a
// JPEG. heic-convert needs the whole container in memory, hence the cap.
//
// Orientation: heic-convert emits no EXIF, but libheif applies the
// container's own rotation/mirror transforms (irot/imir, which is how iPhones
// record orientation) while decoding, so the JPEG is already upright and
// sharp's autoOrient() has nothing left to do. Stored as decoded.

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTENSION = /\.hei[cf]$/i;
const JPEG_QUALITY = 0.92;

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
 * Buffers the part up to `maxBytes` and decodes it to a JPEG stream. Rejects
 * with PayloadTooLargeException (413) past the cap; whatever heic-convert
 * throws for undecodable bytes is passed through for the caller to map to
 * a client error. The part is fully drained on every path: an unconsumed
 * multipart stream hangs the request (see storeImageFromFileUpload).
 */
export async function decodeHeic(
  part: MultipartFile,
  maxBytes: number,
): Promise<Readable> {
  const buffer = await readUpTo(part.file, maxBytes);
  if (!buffer) {
    throw new PayloadTooLargeException(
      `HEIC uploads are limited to ${maxBytes} bytes`,
    );
  }
  const jpeg = await heicConvert({
    buffer,
    format: 'JPEG',
    quality: JPEG_QUALITY,
  });
  return Readable.from(Buffer.from(jpeg));
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
