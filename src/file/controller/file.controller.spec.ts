import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { FastifyReply } from 'fastify';
import { Readable } from 'stream';
import { FileService } from '../file-service.abstract';
import { FileController } from './file.controller';

const PHOTO = '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.webp';

describe('FileController', () => {
  let controller: FileController;
  let fileService: {
    getVariant: jest.Mock;
    getByShareableId: jest.Mock;
    watermarkImage: jest.Mock;
  };
  let reply: { header: jest.Mock; send: jest.Mock; sent: boolean };

  beforeEach(async () => {
    fileService = {
      getVariant: jest.fn(),
      getByShareableId: jest.fn(),
      watermarkImage: jest.fn(),
    };
    reply = { header: jest.fn(), send: jest.fn(), sent: false };
    reply.header.mockReturnValue(reply);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FileController],
      providers: [{ provide: FileService, useValue: fileService }],
    }).compile();

    controller = module.get<FileController>(FileController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it.each([
    ['getFile', 'original'],
    ['nobg', 'nobg'],
    ['thumb', 'thumb'],
  ] as const)(
    '%s streams the %s variant as immutable image/webp',
    async (method, variant) => {
      const stream = Readable.from(Buffer.from('bytes'));
      fileService.getVariant.mockResolvedValue(stream);

      await controller[method](PHOTO, reply);

      expect(fileService.getVariant).toHaveBeenCalledWith(PHOTO, variant);
      expect(reply.header).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=31536000, immutable',
      );
      expect(reply.header).toHaveBeenCalledWith('Content-Type', 'image/webp');
      expect(reply.send).toHaveBeenCalledWith(stream);
    },
  );

  // DATA_PATH also holds app.log; only a photo base name may be served.
  it.each([
    '..',
    '..%2Fetc%2Fpasswd',
    '.hidden',
    'a/b.webp',
    '',
    'app.log',
    'sqlite3.db',
    'abc.webp',
    PHOTO.replace('.webp', '-thumb.webp'),
    `${PHOTO}.log`,
  ])(
    'rejects non-photo file name %p with 404 before touching storage',
    async (fileName) => {
      await expect(
        controller.thumb(fileName, reply as unknown as FastifyReply),
      ).rejects.toThrow(NotFoundException);
      expect(fileService.getVariant).not.toHaveBeenCalled();
    },
  );

  it('propagates a missing original as 404', async () => {
    fileService.getVariant.mockRejectedValue(new NotFoundException());
    await expect(
      controller.nobg(PHOTO, reply as unknown as FastifyReply),
    ).rejects.toThrow(NotFoundException);
  });

  it('watermark resolves the file by shareable id and returns the watermarked stream', async () => {
    const source = Readable.from(Buffer.from('source'));
    const watermarked = Readable.from(Buffer.from('watermarked'));
    fileService.getByShareableId.mockResolvedValue(source);
    fileService.watermarkImage.mockResolvedValue(watermarked);

    await expect(controller.watermark('share-1')).resolves.toBe(watermarked);
    expect(fileService.getByShareableId).toHaveBeenCalledWith('share-1');
    expect(fileService.watermarkImage).toHaveBeenCalledWith(source);
  });
});
