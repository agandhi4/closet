import { MultipartFile } from '@fastify/multipart';
import { EntityManager, EntityRepository } from '@mikro-orm/core';
import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import heicConvert from 'heic-convert';
import sharp from 'sharp';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { File } from '../dal/entity/file.entity';
import { FileService } from './file-service.abstract';
import { StoredObject } from './file-service.interface';

// libheif is WASM and there is no HEIC fixture; the decode branch is about
// what goes in and what comes out of the decoder, not the codec.
vi.mock('heic-convert', () => ({ default: vi.fn() }));
const heicConvertMock = vi.mocked(heicConvert);

const MAX_HEIC_BYTES = 1024;

// Concrete subclass over an in-memory map so the inherited variant logic
// (thumb derivation, fallbacks, versioning) is exercised end to end.
class TestFileService extends FileService {
  files = new Map<string, Buffer>();
  storeCalls: string[] = [];

  get(fileName: string): Promise<Readable> {
    const bytes = this.files.get(fileName);
    if (!bytes) return Promise.reject(new NotFoundException(fileName));
    return Promise.resolve(Readable.from(bytes));
  }

  delete(fileName: string): Promise<void> {
    this.files.delete(fileName);
    return Promise.resolve();
  }

  list(): AsyncIterable<StoredObject> {
    return Readable.from([...this.files.keys()].map((name) => ({ name })));
  }

  protected async store(fileName: string, stream: Readable): Promise<void> {
    this.storeCalls.push(fileName);
    this.files.set(fileName, await collect(stream));
  }
}

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

const build = (watermarkEnabled = false) => {
  const settings: Record<string, unknown> = {
    WATERMARK_ENABLED: watermarkEnabled,
    MAX_HEIC_BYTES,
  };
  const config = {
    get: vi.fn((key: string) => settings[key]),
    getOrThrow: vi.fn((key: string) => settings[key]),
  };
  const fileRow = { fileName: 'a.webp', version: 1 } as File;
  const fileRepository = {
    findOne: vi.fn().mockResolvedValue(fileRow),
    create: vi.fn((data: Partial<File>) => data as File),
  };
  const em = { persistAndFlush: vi.fn(), removeAndFlush: vi.fn() };
  const service = new TestFileService(
    config as unknown as ConfigService,
    fileRepository as unknown as EntityRepository<File>,
    em as unknown as EntityManager,
  );
  return { service, fileRow, fileRepository, em };
};

describe('FileService.getVariant', () => {
  it('serves the original as-is', async () => {
    const { service } = build();
    service.files.set('a.webp', await png(8));
    const out = await collect(await service.getVariant('a.webp', 'original'));
    expect(out.equals(service.files.get('a.webp')!)).toBe(true);
  });

  it('falls back to the original when the cutout is missing', async () => {
    const { service } = build();
    service.files.set('a.webp', await png(8));
    const out = await collect(await service.getVariant('a.webp', 'nobg'));
    expect(out.equals(service.files.get('a.webp')!)).toBe(true);
  });

  it('prefers the cutout when present', async () => {
    const { service } = build();
    service.files.set('a.webp', await png(8));
    service.files.set('a-nobg.webp', await png(9));
    const out = await collect(await service.getVariant('a.webp', 'nobg'));
    expect(out.equals(service.files.get('a-nobg.webp')!)).toBe(true);
  });

  it('generates a <=400px webp thumb on first request and reuses it after', async () => {
    const { service } = build();
    service.files.set('a.webp', await png(1000));

    const first = await collect(await service.getVariant('a.webp', 'thumb'));
    const meta = await sharp(first).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(400);
    expect(meta.height).toBeLessThanOrEqual(400);
    expect(service.storeCalls).toEqual(['a-thumb.webp']);

    await service.getVariant('a.webp', 'thumb');
    expect(service.storeCalls).toEqual(['a-thumb.webp']);
  });

  it('single-flights concurrent first requests for the same thumb', async () => {
    const { service } = build();
    service.files.set('a.webp', await png(1000));
    await Promise.all([
      service.getVariant('a.webp', 'thumb'),
      service.getVariant('a.webp', 'thumb'),
      service.getVariant('a.webp', 'thumb'),
    ]);
    expect(service.storeCalls).toEqual(['a-thumb.webp']);
  });

  it('derives the thumb from the cutout when one exists', async () => {
    const { service } = build();
    service.files.set('a.webp', await png(1000));
    service.files.set('a-nobg.webp', await png(300));
    const out = await collect(await service.getVariant('a.webp', 'thumb'));
    expect((await sharp(out).metadata()).width).toBe(300);
  });

  it('rejects with NotFoundException when the original is missing', async () => {
    const { service } = build();
    await expect(service.getVariant('a.webp', 'thumb')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('FileService.storeNobgVariantFromStream', () => {
  it('stores only the cutout for a new upload: no thumb, version 1', async () => {
    const { service, em, fileRow } = build();
    service.files.set('a.webp', await png(1000));
    await service.storeNobgVariantFromStream(
      Readable.from(await png(600)),
      'a.webp',
      { newUpload: true },
    );
    // The caller builds the one thumb once the photo half is stored too.
    expect(service.storeCalls).toEqual(['a-nobg.webp']);
    expect(em.persistAndFlush).not.toHaveBeenCalled();
    expect(fileRow.version).toBe(1);
  });

  it('bumps the version for a first cutout added after the thumb was served', async () => {
    const { service, fileRow } = build();
    service.files.set('a.webp', await png(1000));
    await service.getVariant('a.webp', 'thumb');
    expect(
      (await sharp(service.files.get('a-thumb.webp')).metadata()).width,
    ).toBe(400);

    await service.storeNobgVariantFromStream(
      Readable.from(await png(300)),
      'a.webp',
      { newUpload: false },
    );
    expect(fileRow.version).toBe(2);
    expect(
      (await sharp(service.files.get('a-thumb.webp')).metadata()).width,
    ).toBe(300);
  });

  it('bumps the version when replacing an existing cutout', async () => {
    const { service, em, fileRow } = build();
    service.files.set('a.webp', await png(1000));
    service.files.set('a-nobg.webp', await png(600));
    await service.storeNobgVariantFromStream(
      Readable.from(await png(500)),
      'a.webp',
      { newUpload: false },
    );
    expect(fileRow.version).toBe(2);
    expect(em.persistAndFlush).toHaveBeenCalledWith(fileRow);
    // The thumb is rewritten before the bump so v=2 never serves a stale thumb.
    expect(service.storeCalls.indexOf('a-thumb.webp')).toBeGreaterThan(
      service.storeCalls.indexOf('a-nobg.webp'),
    );
  });
});

describe('FileService.regenerateThumb', () => {
  it('after a photo + cutout pair, builds one thumb from the cutout', async () => {
    const { service } = build();
    // Mirror GarmentService.storeUploadedPhotoWithCutout: both halves are
    // stored concurrently without thumbs, then one regenerate runs.
    service.files.set('a.webp', await png(1000));
    await service.storeNobgVariantFromStream(
      Readable.from(await png(300)),
      'a.webp',
      { newUpload: true },
    );
    await service.regenerateThumb('a.webp');
    expect(
      (await sharp(service.files.get('a-thumb.webp')).metadata()).width,
    ).toBe(300);
    expect(
      service.storeCalls.filter((name) => name === 'a-thumb.webp'),
    ).toHaveLength(1);
  });
});

describe('FileService.deleteVariants', () => {
  it('removes every variant and tolerates missing ones', async () => {
    const { service } = build();
    service.files.set('a.webp', Buffer.from('x'));
    service.files.set('a-thumb.webp', Buffer.from('x'));
    await service.deleteVariants('a.webp');
    expect(service.files.size).toBe(0);
  });
});

describe('FileService.storeImageFromFileUpload with HEIC', () => {
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

  const decodedJpeg = async () =>
    new Uint8Array(
      await sharp({
        create: { width: 600, height: 400, channels: 3, background: '#48c' },
      })
        .jpeg()
        .toBuffer(),
    );

  // Braced: Vitest runs a function returned from beforeEach as its cleanup,
  // and mockReset() returns the mock itself.
  beforeEach(() => {
    heicConvertMock.mockReset();
  });

  it('decodes image/heic through heic-convert and stores webp original and thumb', async () => {
    const { service } = build();
    heicConvertMock.mockImplementation(decodedJpeg);
    const bytes = Buffer.from('pretend heic container');

    const file = await service.storeImageFromFileUpload(
      part(bytes, 'image/heic'),
      7,
      { fileName: 'a.webp' },
    );

    expect(heicConvertMock).toHaveBeenCalledWith({
      buffer: bytes,
      format: 'JPEG',
      quality: 0.92,
    });
    expect(file.fileName).toBe('a.webp');
    const original = await sharp(service.files.get('a.webp')).metadata();
    expect(original.format).toBe('webp');
    expect(original.width).toBe(600);
    expect(service.files.has('a-thumb.webp')).toBe(true);
  });

  it('recognises a .heic sent as application/octet-stream by its name', async () => {
    const { service } = build();
    heicConvertMock.mockImplementation(decodedJpeg);
    await service.storeImageFromFileUpload(
      part(Buffer.from('x'), 'application/octet-stream', 'IMG_0001.HEIC'),
      7,
      { fileName: 'a.webp' },
    );
    expect(heicConvertMock).toHaveBeenCalledTimes(1);
  });

  it('rejects undecodable bytes with a 400 and stores nothing', async () => {
    const { service } = build();
    heicConvertMock.mockRejectedValue(
      new TypeError('input buffer is not a HEIC image'),
    );
    await expect(
      service.storeImageFromFileUpload(
        part(Buffer.from('not heic'), 'image/heif'),
        7,
        { fileName: 'a.webp' },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(service.files.size).toBe(0);
  });

  it('rejects a part over MAX_HEIC_BYTES with a 413 without decoding', async () => {
    const { service } = build();
    await expect(
      service.storeImageFromFileUpload(
        part(Buffer.alloc(MAX_HEIC_BYTES + 1), 'image/heic'),
        7,
        { fileName: 'a.webp' },
      ),
    ).rejects.toThrow(PayloadTooLargeException);
    expect(heicConvertMock).not.toHaveBeenCalled();
    expect(service.files.size).toBe(0);
  });
});

describe('FileService.watermarkImage', () => {
  const buildWithWatermark = (watermarkEnabled: boolean) => {
    const { service } = build(watermarkEnabled);
    const getWatermark = vi
      .spyOn(service, 'getWatermark')
      .mockImplementation(() => png(4));
    return { service, getWatermark };
  };

  it('skips the composite when WATERMARK_ENABLED is false', async () => {
    const { service, getWatermark } = buildWithWatermark(false);
    const out = await service.watermarkImage(Readable.from(await png(32)));
    expect(getWatermark).not.toHaveBeenCalled();
    expect((await sharp(await collect(out!)).metadata()).format).toBe('jpeg');
  });

  it('composites the icon once when WATERMARK_ENABLED is true', async () => {
    const { service, getWatermark } = buildWithWatermark(true);
    const out = await service.watermarkImage(Readable.from(await png(32)));
    expect(getWatermark).toHaveBeenCalledTimes(1);
    expect((await sharp(await collect(out!)).metadata()).format).toBe('jpeg');
  });
});
