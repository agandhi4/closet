import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as random from '../random';
import { generateIdeas, type IdeaGarment, MAX_DRAWS } from './generator';
import { goesWith } from './goes-with';
import type { Formality, GarmentColor, GarmentRole } from './properties';

/**
 * When the generator stops drawing (#168). Every page it gives is the one
 * MAX_DRAWS draws would (generator-output.spec.ts pins that); these prove it
 * stops as soon as no further draw can change the page, counting the
 * draws through the seeded sequence's `weighted` (one per template, one per
 * open role).
 */

let draws = 0;

vi.mock('../random', async (importOriginal) => {
  const actual = await importOriginal<typeof random>();
  return {
    ...actual,
    seededRandom: (...key: (string | number)[]) => {
      const sequence = actual.seededRandom(...key);
      return {
        ...sequence,
        weighted: (weights: readonly number[]) => {
          draws += 1;
          return sequence.weighted(weights);
        },
      };
    },
  };
});

beforeEach(() => {
  draws = 0;
});

let nextId = 1;

function garment(
  role: GarmentRole,
  colors: GarmentColor[] = ['black'],
  formality: Formality | null = 2,
): IdeaGarment {
  return {
    id: nextId++,
    role,
    colors,
    pattern: 'solid',
    formality,
    weather: { role, warmth: 2, waterResistant: false },
    idleDays: null,
  };
}

/** Tops, bottoms and shoes enough that the draws never walk every base. */
function closet(formality: Formality = 2): IdeaGarment[] {
  return [
    ...Array.from({ length: 20 }, () => garment('top', ['white'], formality)),
    ...Array.from({ length: 15 }, () => garment('bottom', ['blue'], formality)),
    ...Array.from({ length: 10 }, () =>
      garment('footwear', ['black'], formality),
    ),
  ];
}

const DRAWS_PER_BASE = 4; // the template, then top, bottom and footwear

describe('when the generator stops drawing (#168)', () => {
  it('draws until a page and one more fit', () => {
    const page = generateIdeas({
      seed: 1,
      pool: closet(),
      formality: { min: 2, max: 3 },
      offset: 0,
      limit: 6,
    });
    expect(page.ideas).toHaveLength(6);
    expect(page.more).toBe(true);
    expect(draws).toBe(7 * DRAWS_PER_BASE);
  });

  it('never draws for locks that break a hard rule', () => {
    const red = garment('top', ['red']);
    const green = garment('bottom', ['green']);
    const yellow = garment('footwear', ['yellow']);
    const page = generateIdeas({
      seed: 1,
      pool: closet(),
      locked: [red, green, yellow],
      offset: 0,
      limit: 6,
    });
    expect(page).toEqual({ ideas: [], more: false });
    expect(draws).toBe(0);
  });

  it('stops once every combination was drawn', () => {
    const small = [
      garment('top'),
      garment('top'),
      garment('bottom'),
      garment('footwear'),
      garment('footwear'),
    ];
    const page = generateIdeas({ seed: 1, pool: small, offset: 0, limit: 50 });
    expect(page.ideas).toHaveLength(4);
    expect(draws).toBeLessThan(MAX_DRAWS / 10);
  });

  it('stops at the best score any idea can reach, when none can fit', () => {
    // A dressy wishlist blazer judged at its own formality (4) against a
    // closet of 2s: every idea misses by the same 3 steps a garment, so
    // the first page and one more at that floor settle it.
    const blazer = garment('layer', ['black'], 4);
    const page = generateIdeas({
      seed: 1,
      pool: closet(2),
      locked: [blazer],
      formality: { min: 4, max: 4 },
      offset: 0,
      limit: 1,
    });
    expect(page.ideas[0].score).toBe(6);
    expect(draws).toBe(2 * DRAWS_PER_BASE);
  });

  it('checks a layer that never makes the item\'s formality in a few draws ("Goes with my closet")', () => {
    const item = garment('top', ['white'], 3);
    const casualLayers = [
      garment('layer', ['grey'], 1),
      garment('layer', ['beige'], 1),
    ];
    const found = goesWith({
      item,
      closet: [...closet(3), ...casualLayers],
      avoid: [],
      seed: item.id,
    });
    const layers = found.roles.find((role) => role.role === 'layer')!;
    expect(layers.goes).toBe(2);
    expect(layers.best.every((p) => !p.atFormality)).toBe(true);
    // Three a base with the top locked: the template, a bottom, a shoe. The
    // item's own search walks every draw (it counts outfits); each layer
    // check stops within a few, where it used to walk every draw too.
    expect(draws).toBeLessThan(MAX_DRAWS * 3 + 100);
  });
});
