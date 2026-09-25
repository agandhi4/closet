import { isStaticPath } from './static-prefixes';

describe('isStaticPath', () => {
  it.each([
    '/modules/htmx.min.js',
    '/modules/background-removal/index.js',
    '/assets/icon.png',
    '/js/mask-editor.js',
    '/bg-removal-models/model.onnx',
    '/file/8d755fce.webp?v=3',
    '/file/nobg/8d755fce.webp',
    '/file/thumb/8d755fce.webp?v=1',
    '/file/watermark/abc',
    '/bundle.css',
    '/sw.js?ts=1',
    '/manifest.json',
    '/favicon.ico',
    '/robots.txt',
  ])('treats %s as static', (url) => {
    expect(isStaticPath(url)).toBe(true);
  });

  it.each([
    '/',
    '/wardrobe',
    '/wardrobe/12?ownerId=3',
    '/auth/login',
    '/auth/profile',
    '/file/files',
    '/file/upload',
    '/modules',
    '/filebrowser',
    '/assetsx',
  ])('treats %s as an app route', (url) => {
    expect(isStaticPath(url)).toBe(false);
  });
});
