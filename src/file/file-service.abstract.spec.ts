import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { Readable } from 'stream';
import { File } from '../dal/entity/file.entity';
import { FileService } from './file-service.abstract';

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
  const config = { get: jest.fn().mockReturnValue(watermarkEnabled) };
  const fileRow = { fileName: 'a.webp', version: 1 } as File;
  const fileRepository = { findOne: jest.fn().mockResolvedValue(fileRow) };
  const em = { persistAndFlush: jest.fn(), removeAndFlush: jest.fn() };
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
  it('keeps version 1 for a cutout that belongs to a new upload', async () => {
    const { service, em, fileRow } = build();
    service.files.set('a.webp', await png(1000));
    await service.storeNobgVariantFromStream(
      Readable.from(await png(600)),
      'a.webp',
      { newUpload: true },
    );
    expect(service.storeCalls).toEqual(['a-nobg.webp', 'a-thumb.webp']);
    expect(
      (await sharp(service.files.get('a-thumb.webp')).metadata()).width,
    ).toBe(400);
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
  it('a trailing regenerate after a concurrent upload always reads the cutout', async () => {
    const { service } = build();
    // Mirror GarmentService.update: original and cutout land concurrently and
    // each queue a thumb write in unknown order; the explicit final call wins.
    service.files.set('a.webp', await png(1000));
    await Promise.all([
      service.regenerateThumb('a.webp'),
      service.storeNobgVariantFromStream(
        Readable.from(await png(300)),
        'a.webp',
        { newUpload: true },
      ),
    ]);
    await service.regenerateThumb('a.webp');
    expect(
      (await sharp(service.files.get('a-thumb.webp')).metadata()).width,
    ).toBe(300);
    expect(service.storeCalls.at(-1)).toBe('a-thumb.webp');
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

describe('FileService.watermarkImage', () => {
  const buildWithWatermark = (watermarkEnabled: boolean) => {
    const { service } = build(watermarkEnabled);
    const getWatermark = jest
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
