import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  // Android's share sheet: a shared product page opens the link import,
  // whose GET takes the link from `url` or from inside `text`
  // (link-import.spec.ts).
  it('names the link import as the share target, by GET', async () => {
    const res = await t.inject({ method: 'GET', url: '/manifest.json' });
    expect(res.json().share_target).toEqual({
      action: '/wardrobe/new/from-link',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    });
  });
});
