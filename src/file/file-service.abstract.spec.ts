import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { Readable } from 'stream';
import { FileService } from './file-service.abstract';

// Minimal concrete subclass: only the inherited watermarkImage is under test.
class TestFileService extends FileService {
  storeImageFromFileUpload = jest.fn();
  copyImage = jest.fn();
  delete = jest.fn();
  deleteById = jest.fn();
  get = jest.fn();
  getByShareableId = jest.fn();
  protected store = jest.fn();
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

describe('FileService.watermarkImage', () => {
  const build = (watermarkEnabled: boolean) => {
    const config = { get: jest.fn().mockReturnValue(watermarkEnabled) };
    const service = new TestFileService(config as unknown as ConfigService);
    const getWatermark = jest
      .spyOn(service, 'getWatermark')
      .mockImplementation(() => png(4));
    return { service, getWatermark };
  };

  it('skips the composite when WATERMARK_ENABLED is false', async () => {
    const { service, getWatermark } = build(false);
    const out = await service.watermarkImage(Readable.from(await png(32)));
    expect(getWatermark).not.toHaveBeenCalled();
    expect((await sharp(await collect(out!)).metadata()).format).toBe('jpeg');
  });

  it('composites the icon once when WATERMARK_ENABLED is true', async () => {
    const { service, getWatermark } = build(true);
    const out = await service.watermarkImage(Readable.from(await png(32)));
    expect(getWatermark).toHaveBeenCalledTimes(1);
    expect((await sharp(await collect(out!)).metadata()).format).toBe('jpeg');
  });
});
