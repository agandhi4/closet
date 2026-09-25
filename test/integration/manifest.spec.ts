import { createTestApp, TestApp } from './harness';

describe('GET /manifest.json', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ APP_NAME: 'Household Closet' });
  });

  afterAll(() => t?.cleanup());

  it('serves the web manifest from config', async () => {
    const res = await t.inject({ method: 'GET', url: '/manifest.json' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/manifest+json; charset=utf-8',
    );
    const manifest = res.json();
    expect(manifest.name).toBe('Household Closet');
    expect(manifest.short_name).toBe('Household Closet');
    expect(manifest.icons[0].src).toBe('/assets/icon.png');
    expect(manifest.start_url).toBe('/wardrobe');
  });
});
