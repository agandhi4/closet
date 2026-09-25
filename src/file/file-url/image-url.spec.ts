import { imageUrl } from './image-url';

describe('imageUrl', () => {
  const photo = { fileName: 'abc.webp', version: 3 };

  it('builds the original path', () => {
    expect(imageUrl(photo, 'original')).toBe('/file/abc.webp?v=3');
  });

  it('builds the nobg path', () => {
    expect(imageUrl(photo, 'nobg')).toBe('/file/nobg/abc.webp?v=3');
  });

  it('builds the thumb path', () => {
    expect(imageUrl(photo, 'thumb')).toBe('/file/thumb/abc.webp?v=3');
  });

  it('defaults the version to 1 when absent', () => {
    expect(imageUrl({ fileName: 'abc.webp' }, 'thumb')).toBe(
      '/file/thumb/abc.webp?v=1',
    );
  });

  it('percent-encodes the file name', () => {
    expect(imageUrl({ fileName: 'a b.webp' }, 'original')).toBe(
      '/file/a%20b.webp?v=1',
    );
  });
});
