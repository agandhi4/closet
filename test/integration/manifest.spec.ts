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
    // Issue #48: the small rasters, smallest first (<pwa-install> shows the
    // first); the 1000 px icon.png is for link previews only.
    expect(
      manifest.icons.map((icon: { src: string; sizes: string }) => [
        icon.src,
        icon.sizes,
      ]),
    ).toEqual([
      ['/assets/icon-192.png', '192x192'],
      ['/assets/icon-512.png', '512x512'],
    ]);
    // The installed app opens to Today (#15); its identity never moves.
    expect(manifest.start_url).toBe('/');
    expect(manifest.id).toBe('/wardrobe');
    // Issue #4: the install dialogs show none, so none are fetched.
    expect(manifest).not.toHaveProperty('screenshots');
  });

  // Issue #81: the title bar and splash take the light theme's page colour
  // (THEME_BASE_100, checked against main.css by theme-colors.spec.ts).
  it('colours the installed app from the theme', async () => {
    const res = await t.inject({ method: 'GET', url: '/manifest.json' });
    const manifest = res.json();
    expect(manifest.theme_color).toBe('#faf8f4');
    expect(manifest.background_color).toBe('#faf8f4');
  });

  it('gives the page a theme colour per colour scheme', async () => {
    const res = await t.inject({ method: 'GET', url: '/about' });
    expect(res.body).toContain(
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf8f4"/>',
    );
    expect(res.body).toContain(
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#191512"/>',
    );
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
