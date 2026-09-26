import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { GARMENT_TYPES } from '../wardrobe/properties';
import { ART_SIZE, garmentSvg, shapeOf } from './art';

describe('garment art', () => {
  const types = Object.entries(GARMENT_TYPES).flatMap(([category, list]) =>
    list.map((type) => ({ category, type: type.value })),
  );

  it.each(types)(
    'draws $category / $type as its own shape',
    ({ category, type }) => {
      expect(
        shapeOf({ category, type, name: null, colors: [], pattern: null }),
      ).toBe(type);
    },
  );

  it('falls back to what the name says, then the category, then a folded square', () => {
    const shape = (category: string, name: string) =>
      shapeOf({ category, type: null, name, colors: [], pattern: null });
    expect(shape('outerwear', 'puffer')).toBe('puffer');
    expect(shape('bottoms', 'work pants')).toBe('trousers');
    expect(shape('tops', 'grey tshirt')).toBe('t-shirt');
    expect(shape('bags', 'big bag')).toBe('tote');
    expect(shape('scrubs', 'scrubs top??')).toBe('folded');
  });

  it('renders the same pixels every time, transparent around the garment', async () => {
    const subject = {
      category: 'tops',
      type: 'long-sleeve-tee',
      name: 'Breton',
      colors: ['white', 'blue'],
      pattern: 'stripes',
    };
    expect(garmentSvg(subject)).toBe(garmentSvg(subject));
    const { data, info } = await sharp(Buffer.from(garmentSvg(subject)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([ART_SIZE, ART_SIZE]);
    expect(data[3]).toBe(0);
    const centre = (ART_SIZE / 2) * ART_SIZE * 4 + (ART_SIZE / 2) * 4;
    expect(data[centre + 3]).toBe(255);
  });
});
