import { MultipartFile } from '@fastify/multipart';
import heicDecode from 'heic-decode';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors';
import { decodeHeic, isHeicUpload } from './heic';

// libheif is WASM and there is no HEIC fixture: the decoder is mocked, and
// these cover what goes in and what is allowed out.
vi.mock('heic-decode', () => ({ default: { all: vi.fn() } }));
const allMock = vi.mocked(heicDecode.all);

/** heic-decode's all(): the container's images, pixels decoded on demand. */
const container = (width: number, height: number) => {
  const decode = vi.fn(() =>
    Promise.resolve({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4).fill(7),
    }),
  );
  const dispose = vi.fn();
  const images = Object.assign([{ width, height, decode }], { dispose });
  allMock.mockResolvedValue(images);
  return { decode, dispose };
};

const heicPart = (bytes = 'heic') =>
  ({ file: Readable.from(Buffer.from(bytes)) }) as MultipartFile;

const part = (mimetype: string, filename: string): MultipartFile =>
  ({ mimetype, filename }) as MultipartFile;

describe('isHeicUpload', () => {
  it.each([
    ['image/heic', 'photo.jpg', true],
    ['image/heif', 'photo', true],
    ['application/octet-stream', 'IMG_1.HEIC', true],
    ['application/octet-stream', 'IMG_1.heif', true],
    ['application/octet-stream', 'IMG_1.jpg', false],
    ['image/jpeg', 'photo.heic', false],
  ])('%s %s -> %s', (mimetype, filename, expected) => {
    expect(isHeicUpload(part(mimetype, filename))).toBe(expected);
  });
});

describe('decodeHeic', () => {
  // Braced: Vitest runs a function returned from beforeEach as its cleanup,
  // and mockReset() returns the mock itself.
  beforeEach(() => {
    allMock.mockReset();
  });

  it('drains the whole part before rejecting an oversized upload', async () => {
    const chunks = [Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)];
    let read = 0;
    const file = Readable.from(
      (function* () {
        for (const chunk of chunks) {
          read += 1;
          yield chunk;
        }
      })(),
    );
    const refused = decodeHeic(
      { file, filename: 'big.heic' } as MultipartFile,
      1000,
      1_000_000,
    );
    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(refused).rejects.toMatchObject({ statusCode: 413 });
    // busboy only moves to the next part once this one is consumed.
    expect(read).toBe(chunks.length);
    expect(allMock).not.toHaveBeenCalled();
  });

  it('returns the primary image as raw RGBA pixels with their layout', async () => {
    const { dispose } = container(3, 2);
    const decoded = await decodeHeic(heicPart(), 1000, 1_000_000);

    expect(allMock).toHaveBeenCalledWith({ buffer: Buffer.from('heic') });
    expect(decoded.raw).toEqual({ width: 3, height: 2, channels: 4 });
    const out: Buffer[] = [];
    for await (const chunk of decoded.pixels) out.push(chunk as Buffer);
    expect(Buffer.concat(out)).toEqual(Buffer.alloc(3 * 2 * 4, 7));
    // libheif's WASM memory is freed on every path.
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('refuses more pixels than allowed before decoding any', async () => {
    // A few bytes can declare a 20000x20000 grid: 1.6 GB once decoded.
    const { decode, dispose } = container(20_000, 20_000);
    const refused = decodeHeic(heicPart(), 1000, 64_000_000);

    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(refused).rejects.toMatchObject({
      statusCode: 400,
      message: 'Image too large',
    });
    expect(decode).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
