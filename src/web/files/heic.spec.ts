import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors';
import { decodeHeic, isHeicUpload } from './heic';
import { HeicDecodeError, type HeicDecoding } from './heic-decoder';

// The thread itself is heic-decoder.spec.ts's; these cover what decodeHeic
// sends the decoder and how each of its answers reaches the caller.
const decoder = (
  answer: (read: () => Promise<Buffer>) => ReturnType<HeicDecoding['decode']>,
): HeicDecoding => ({ decode: vi.fn(answer), close: vi.fn() });

/** A part that counts how many of its chunks were read. */
const countedPart = (chunks: Buffer[]) => {
  const counter = { read: 0 };
  const stream = Readable.from(
    (function* () {
      for (const chunk of chunks) {
        counter.read += 1;
        yield chunk;
      }
    })(),
  );
  return { stream, counter };
};

describe('isHeicUpload', () => {
  it.each([
    ['image/heic', 'photo.jpg', true],
    ['image/heif', 'photo', true],
    ['application/octet-stream', 'IMG_1.HEIC', true],
    ['application/octet-stream', 'IMG_1.heif', true],
    ['application/octet-stream', 'IMG_1.jpg', false],
    ['image/jpeg', 'photo.heic', false],
  ])('%s %s -> %s', (mimetype, filename, expected) => {
    expect(isHeicUpload({ mimetype, filename })).toBe(expected);
  });
});

describe('decodeHeic', () => {
  it('hands the decoder the whole part and answers its pixels with their layout', async () => {
    let container: Buffer | undefined;
    const pixels = Buffer.alloc(3 * 2 * 4, 7);
    const decoded = await decodeHeic(
      Readable.from([Buffer.from('he'), Buffer.from('ic')]),
      1000,
      1_000_000,
      decoder(async (read) => {
        container = await read();
        return { width: 3, height: 2, pixels };
      }),
    );

    expect(container).toEqual(Buffer.from('heic'));
    expect(decoded.raw).toEqual({ width: 3, height: 2, channels: 4 });
    const out: Buffer[] = [];
    for await (const chunk of decoded.pixels) out.push(chunk as Buffer);
    expect(Buffer.concat(out)).toEqual(pixels);
  });

  it('drains the whole part before rejecting an oversized upload with a 413', async () => {
    const { stream, counter } = countedPart([
      Buffer.alloc(600),
      Buffer.alloc(600),
      Buffer.alloc(600),
    ]);
    const refused = decodeHeic(
      stream,
      1000,
      1_000_000,
      decoder(async (read) => {
        await read();
        throw new Error('never decoded');
      }),
    );
    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(refused).rejects.toMatchObject({ statusCode: 413 });
    // busboy only moves to the next part once this one is consumed.
    expect(counter.read).toBe(3);
  });

  it('answers too many pixels as "Image too large"', async () => {
    await expect(
      decodeHeic(
        Readable.from([Buffer.from('heic')]),
        1000,
        64_000_000,
        decoder(async (read) => {
          await read();
          throw new HeicDecodeError('too-large', '20000x20000');
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Image too large' });
  });

  it('refuses with a 503 and Retry-After when the decoder is full, draining the part it never buffered', async () => {
    const { stream, counter } = countedPart([Buffer.alloc(600)]);
    // The decoder refuses before calling `read`, as HeicDecoder does.
    const refused = decodeHeic(
      stream,
      1000,
      1_000_000,
      decoder(() => Promise.reject(new HeicDecodeError('busy', '4 waiting'))),
    );
    await expect(refused).rejects.toMatchObject({
      statusCode: 503,
      retryAfterSeconds: 5,
    });
    expect(counter.read).toBe(1);
  });

  it('passes any other decode failure through for the caller to map', async () => {
    const failure = new HeicDecodeError('timeout', '30000 ms');
    await expect(
      decodeHeic(
        Readable.from([Buffer.from('heic')]),
        1000,
        1_000_000,
        decoder(() => Promise.reject(failure)),
      ),
    ).rejects.toBe(failure);
  });
});
