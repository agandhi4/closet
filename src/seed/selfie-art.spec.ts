import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ArtSubject } from './art';
import { mirrorSelfieSvg, SELFIE_HEIGHT, SELFIE_WIDTH } from './selfie-art';

describe('outfit selfie art', () => {
  const garments: ArtSubject[] = [
    {
      category: 'tops',
      type: 'long-sleeve-tee',
      name: 'Breton',
      colors: ['white', 'blue'],
      pattern: 'stripes',
    },
    {
      category: 'bottoms',
      type: 'chinos',
      name: 'Olive chinos',
      colors: ['green'],
      pattern: 'check',
    },
    {
      category: 'footwear',
      type: null,
      name: 'Loafers',
      colors: ['brown'],
      pattern: null,
    },
    {
      category: 'accessories',
      type: null,
      name: 'Watch',
      colors: ['silver'],
      pattern: null,
    },
  ];

  it('gives every garment its own pattern, so two patterns never collide', () => {
    const svg = mirrorSelfieSvg(garments, 0);
    const ids = [...svg.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(svg).toContain(`url(#${id})`);
  });

  it('renders the same opaque portrait every time, a room per turn', async () => {
    const svg = mirrorSelfieSvg(garments, 4);
    expect(svg).toBe(mirrorSelfieSvg(garments, 4));
    expect(svg).not.toBe(mirrorSelfieSvg(garments, 5));
    const { data, info } = await sharp(Buffer.from(svg))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([SELFIE_WIDTH, SELFIE_HEIGHT]);
    // A photo has no transparency: the corner is the wall.
    expect(data[3]).toBe(255);
  });
});
