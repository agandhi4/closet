import type { MultipartFile } from '@fastify/multipart';
import heicDecode from 'heic-decode';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import type { WebLogger } from '../logger';
import { MAX_INPUT_PIXELS, Photos } from './photos';
import { bumpPhotoVersion, findPhotoByShareableId } from './queries';
import { PhotoStorage } from './storage';

// libheif is WASM and there is no HEIC fixture; the decode branch is about
// what goes in and what comes out of the decoder, not the codec.
vi.mock('heic-decode', () => ({ default: { all: vi.fn() } }));
const heicMock = vi.mocked(heicDecode.all);

// The two row queries Photos makes; the integration tier runs them for real.
vi.mock('./queries', () => ({
  bumpPhotoVersion: vi.fn(),
  findPhotoByShareableId: vi.fn(),
}));
const bumpMock = vi.mocked(bumpPhotoVersion);
const findByShareMock = vi.mocked(findPhotoByShareableId);

const MAX_HEIC_BYTES = 1024;

const png = (size: number) =>
  sharp({
    create: { width: size, height: size, channels: 4, background: '#fff' },
  })
    .png()
    .toBuffer();

const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const logger: WebLogger = {
  debug: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Photos over real disk storage in a temp directory, so the variant logic
// (thumb derivation, fallbacks, atomic writes) runs end to end; `stores`
// records every name written.
let dataPath: string;
let stores: string[];

const build = ({ watermarkEnabled = false } = {}) => {
  const storage = new PhotoStorage(dataPath, logger);
  storage.prepare();
  const store = storage.store.bind(storage);
  vi.spyOn(storage, 'store').mockImplementation((name, stream) => {
    stores.push(name);
    return store(name, stream);
  });
  const photos = new Photos(storage, {} as Db, logger, {
    maxHeicBytes: MAX_HEIC_BYTES,
    watermarkIconPath: join(dataPath, 'icon.png'),
    watermarkEnabled,
  });
  return photos;
};

const put = (name: string, bytes: Buffer) =>
  writeFile(join(dataPath, name), bytes);
const stored = (name: string) => readFile(join(dataPath, name));
const has = (name: string) => existsSync(join(dataPath, name));

beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'closet-photos-'));
  stores = [];
  bumpMock.mockReset();
  findByShareMock.mockReset();
});

afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true });
});

describe('Photos.getVariant', () => {
  it('serves the original as-is', async () => {
    const photos = build();
    await put('a.webp', await png(8));
    const out = await collect(await photos.getVariant('a.webp', 'original'));
    expect(out.equals(await stored('a.webp'))).toBe(true);
  });

  it('falls back to the original when the cutout is missing', async () => {
    const photos = build();
    await put('a.webp', await png(8));
    const out = await collect(await photos.getVariant('a.webp', 'nobg'));
    expect(out.equals(await stored('a.webp'))).toBe(true);
  });

  it('prefers the cutout when present', async () => {
    const photos = build();
    await put('a.webp', await png(8));
    await put('a-nobg.webp', await png(9));
    const out = await collect(await photos.getVariant('a.webp', 'nobg'));
    expect(out.equals(await stored('a-nobg.webp'))).toBe(true);
  });

  it('generates a <=400px webp thumb on first request and reuses it after', async () => {
    const photos = build();
    await put('a.webp', await png(1000));

    const first = await collect(await photos.getVariant('a.webp', 'thumb'));
    const meta = await sharp(first).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(400);
    expect(meta.height).toBeLessThanOrEqual(400);
    expect(stores).toEqual(['a-thumb.webp']);

    await collect(await photos.getVariant('a.webp', 'thumb'));
    expect(stores).toEqual(['a-thumb.webp']);
  });

  it('single-flights concurrent first requests for the same thumb', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    const streams = await Promise.all([
      photos.getVariant('a.webp', 'thumb'),
      photos.getVariant('a.webp', 'thumb'),
      photos.getVariant('a.webp', 'thumb'),
    ]);
    await Promise.all(streams.map(collect));
    expect(stores).toEqual(['a-thumb.webp']);
  });

  it('derives the thumb from the cutout when one exists', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await png(300));
    const out = await collect(await photos.getVariant('a.webp', 'thumb'));
    expect((await sharp(out).metadata()).width).toBe(300);
  });

  it('is a 404 when the original is missing', async () => {
    const photos = build();
    await expect(photos.getVariant('a.webp', 'thumb')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('Photos.storeCutout', () => {
  it('stores only the cutout for a new upload: no thumb, no version bump', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await expect(
      photos.storeCutout(Readable.from(await png(600)), 'a.webp', {
        newUpload: true,
      }),
    ).resolves.toBeUndefined();
    // The caller builds the one thumb once the photo half is stored too.
    expect(stores).toEqual(['a-nobg.webp']);
    expect(bumpMock).not.toHaveBeenCalled();
  });

  it('rewrites the thumb from a first cutout added after the thumb was served', async () => {
    const photos = build();
    bumpMock.mockResolvedValue(2);
    await put('a.webp', await png(1000));
    await collect(await photos.getVariant('a.webp', 'thumb'));
    expect((await sharp(await stored('a-thumb.webp')).metadata()).width).toBe(
      400,
    );

    await expect(
      photos.storeCutout(Readable.from(await png(300)), 'a.webp', {
        newUpload: false,
      }),
    ).resolves.toBe(2);
    expect((await sharp(await stored('a-thumb.webp')).metadata()).width).toBe(
      300,
    );
  });

  it('bumps the version only after the thumb is rewritten when replacing a cutout', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await png(600));
    bumpMock.mockImplementation(() => {
      // The new thumb is on disk before any client can see the new version.
      expect(stores).toEqual(['a-nobg.webp', 'a-thumb.webp']);
      return Promise.resolve(2);
    });
    await expect(
      photos.storeCutout(Readable.from(await png(500)), 'a.webp', {
        newUpload: false,
      }),
    ).resolves.toBe(2);
    expect(bumpMock).toHaveBeenCalledWith({}, 'a.webp');
  });
});

describe('Photos.regenerateThumb', () => {
  it('after a photo + cutout pair, builds one thumb from the cutout', async () => {
    const photos = build();
    // Mirror GarmentService.storeUploadedPhotoWithCutout: both halves are
    // stored concurrently without thumbs, then one regenerate runs.
    await put('a.webp', await png(1000));
    await photos.storeCutout(Readable.from(await png(300)), 'a.webp', {
      newUpload: true,
    });
    await photos.regenerateThumb('a.webp');
    expect((await sharp(await stored('a-thumb.webp')).metadata()).width).toBe(
      300,
    );
    expect(stores.filter((name) => name === 'a-thumb.webp')).toHaveLength(1);
  });
});

describe('Photos.deleteVariants', () => {
  it('removes every variant and tolerates missing ones', async () => {
    const photos = build();
    await put('a.webp', Buffer.from('x'));
    await put('a-thumb.webp', Buffer.from('x'));
    await photos.deleteVariants('a.webp');
    expect(has('a.webp')).toBe(false);
    expect(has('a-thumb.webp')).toBe(false);
  });
});

describe('Photos.copy', () => {
  it('copies the original and the cutout under a new name, with a new thumb', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await png(300));

    const row = await photos.copy('a.webp', 7);

    expect(row).toMatchObject({ createdById: 7 });
    expect(row!.fileName).toMatch(/^[0-9a-f-]{36}\.webp$/);
    expect(row!.shareableId).toMatch(/^[0-9a-f-]{36}$/);
    const base = row!.fileName.replace('.webp', '');
    expect((await stored(row!.fileName)).equals(await stored('a.webp'))).toBe(
      true,
    );
    expect(
      (await stored(`${base}-nobg.webp`)).equals(await stored('a-nobg.webp')),
    ).toBe(true);
    expect(
      (await sharp(await stored(`${base}-thumb.webp`)).metadata()).width,
    ).toBe(300);
  });

  it('returns undefined when the source is gone', async () => {
    const photos = build();
    await expect(photos.copy('a.webp', 7)).resolves.toBeUndefined();
    expect(stores).toEqual([]);
  });
});

describe('Photos.storeUpload', () => {
  const part = (
    data: Buffer,
    mimetype: string,
    filename = 'photo.heic',
  ): MultipartFile =>
    ({
      file: Readable.from(data),
      mimetype,
      filename,
      fieldname: 'photo',
    }) as unknown as MultipartFile;

  /** heic-decode's view of a container holding one width x height image. */
  const heicContainer = (width: number, height: number) =>
    Object.assign(
      [
        {
          width,
          height,
          decode: () =>
            Promise.resolve({
              width,
              height,
              data: new Uint8ClampedArray(width * height * 4).fill(200),
            }),
        },
      ],
      { dispose: vi.fn() },
    );

  // Braced: Vitest runs a function returned from beforeEach as its cleanup,
  // and mockReset() returns the mock itself.
  beforeEach(() => {
    heicMock.mockReset();
  });

  it('returns the row to insert, with a fresh share id, and stores original and thumb', async () => {
    const photos = build();
    const row = await photos.storeUpload(
      part(await png(1200), 'image/png', 'photo.png'),
      7,
    );
    expect(row).toEqual({
      fileName: expect.stringMatching(/^[0-9a-f-]{36}\.webp$/) as string,
      shareableId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      createdOn: expect.any(String) as string,
      createdById: 7,
    });
    expect(new Date(row.createdOn).toISOString()).toBe(row.createdOn);
    expect((await sharp(await stored(row.fileName)).metadata()).width).toBe(
      1080,
    );
    expect(has(row.fileName.replace('.webp', '-thumb.webp'))).toBe(true);
  });

  it('with deferThumb stores only the original under the given name', async () => {
    const photos = build();
    await photos.storeUpload(part(await png(600), 'image/png', 'p.png'), 7, {
      fileName: 'a.webp',
      deferThumb: true,
    });
    expect(stores).toEqual(['a.webp']);
  });

  it('refuses a part that is not an image with a 400', async () => {
    const photos = build();
    await expect(
      photos.storeUpload(part(Buffer.from('x'), 'text/plain', 'a.txt'), 7),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Wrong filetype' });
    expect(stores).toEqual([]);
  });

  it('decodes image/heic to pixels and stores webp original and thumb', async () => {
    const photos = build();
    heicMock.mockResolvedValue(heicContainer(600, 400));
    const bytes = Buffer.from('pretend heic container');

    const row = await photos.storeUpload(part(bytes, 'image/heic'), 7, {
      fileName: 'a.webp',
    });

    expect(heicMock).toHaveBeenCalledWith({ buffer: bytes });
    expect(row.fileName).toBe('a.webp');
    const original = await sharp(await stored('a.webp')).metadata();
    expect(original.format).toBe('webp');
    expect(original.width).toBe(600);
    expect(has('a-thumb.webp')).toBe(true);
  });

  it('recognises a .heic sent as application/octet-stream by its name', async () => {
    const photos = build();
    heicMock.mockResolvedValue(heicContainer(60, 40));
    await photos.storeUpload(
      part(Buffer.from('x'), 'application/octet-stream', 'IMG_0001.HEIC'),
      7,
      { fileName: 'a.webp' },
    );
    expect(heicMock).toHaveBeenCalledTimes(1);
  });

  it('rejects undecodable HEIC bytes with a 400 and stores nothing', async () => {
    const photos = build();
    heicMock.mockRejectedValue(
      new TypeError('input buffer is not a HEIC image'),
    );
    const refused = photos.storeUpload(
      part(Buffer.from('not heic'), 'image/heif'),
      7,
      { fileName: 'a.webp' },
    );
    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(refused).rejects.toMatchObject({ statusCode: 400 });
    expect(has('a.webp')).toBe(false);
  });

  it('rejects a HEIC part over MAX_HEIC_BYTES with a 413 without decoding', async () => {
    const photos = build();
    await expect(
      photos.storeUpload(
        part(Buffer.alloc(MAX_HEIC_BYTES + 1), 'image/heic'),
        7,
        { fileName: 'a.webp' },
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(heicMock).not.toHaveBeenCalled();
    expect(has('a.webp')).toBe(false);
  });

  it('refuses a HEIC declaring more pixels than MAX_INPUT_PIXELS with a 400', async () => {
    const photos = build();
    heicMock.mockResolvedValue(heicContainer(10_000, 10_000));
    await expect(
      photos.storeUpload(part(Buffer.from('x'), 'image/heic'), 7, {
        fileName: 'a.webp',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Image too large' });
    expect(has('a.webp')).toBe(false);
  });

  it('refuses any image over MAX_INPUT_PIXELS with a 400 before decoding it', async () => {
    const photos = build();
    // A real PNG of one colour: a few KB of file, 81 MP of pixels.
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1000;
    const bomb = await sharp({
      create: { width: side, height: side, channels: 3, background: '#000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(
      photos.storeUpload(part(bomb, 'image/png', 'bomb.png'), 7, {
        fileName: 'a.webp',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Image too large' });
    expect(has('a.webp')).toBe(false);
  }, 30_000);

  it('rejects undecodable image bytes with a 400 and leaves no partial file', async () => {
    const photos = build();
    await expect(
      photos.storeUpload(
        part(Buffer.from('not a jpeg'), 'image/jpeg', 'p.jpg'),
        7,
        { fileName: 'a.webp' },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Unreadable image' });
    expect(has('a.webp')).toBe(false);
  });
});

describe('Photos.watermarked', () => {
  beforeEach(async () => {
    // Red on the white photo, so a composite changes the output.
    await put(
      'icon.png',
      await sharp({
        create: { width: 64, height: 64, channels: 4, background: '#f00' },
      })
        .png()
        .toBuffer(),
    );
    // Larger than the 170px watermark: sharp composites only onto a
    // background at least the overlay's size.
    await put('a.webp', await png(400));
    findByShareMock.mockResolvedValue('a.webp');
  });

  it('serves the original as a JPEG without the icon when WATERMARK_ENABLED is false', async () => {
    const photos = build({ watermarkEnabled: false });
    const out = await collect(await photos.watermarked('share-1'));
    expect(findByShareMock).toHaveBeenCalledWith({}, 'share-1');
    expect((await sharp(out).metadata()).format).toBe('jpeg');
  });

  it('composites the icon when WATERMARK_ENABLED is true', async () => {
    const photos = build({ watermarkEnabled: true });
    const plain = await collect(
      await build({ watermarkEnabled: false }).watermarked('share-1'),
    );
    const out = await collect(await photos.watermarked('share-1'));
    expect((await sharp(out).metadata()).format).toBe('jpeg');
    expect(out.equals(plain)).toBe(false);
  });

  it('is a 404 for an unknown share id', async () => {
    findByShareMock.mockResolvedValue(undefined);
    await expect(build().watermarked('nope')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
