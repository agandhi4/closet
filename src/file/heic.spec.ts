import { MultipartFile } from '@fastify/multipart';
import { PayloadTooLargeException } from '@nestjs/common';
import heicConvert from 'heic-convert';
import { Readable } from 'stream';
import { decodeHeic, isHeicUpload } from './heic';

jest.mock('heic-convert', () => jest.fn());
const heicConvertMock = heicConvert as unknown as jest.Mock;

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
  beforeEach(() => heicConvertMock.mockReset());

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
    await expect(
      decodeHeic({ file, filename: 'big.heic' } as MultipartFile, 1000),
    ).rejects.toThrow(PayloadTooLargeException);
    // busboy only moves to the next part once this one is consumed.
    expect(read).toBe(chunks.length);
    expect(heicConvertMock).not.toHaveBeenCalled();
  });

  it('returns the decoder output as a readable JPEG stream', async () => {
    heicConvertMock.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff]));
    const stream = await decodeHeic(
      { file: Readable.from(Buffer.from('heic')) } as MultipartFile,
      1000,
    );
    const out: Buffer[] = [];
    for await (const chunk of stream) out.push(chunk as Buffer);
    expect(Buffer.concat(out)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});
