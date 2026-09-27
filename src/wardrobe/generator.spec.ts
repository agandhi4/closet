import { describe, expect, it } from 'vitest';
import type { DayForecast } from '../weather/forecast';
import { type WeatherNeeds, weatherNeeds } from '../weather/match';
import {
  colorsGoTogether,
  generateIdeas,
  type Idea,
  type IdeaGarment,
  type IdeaRequest,
  keyOf,
  MAX_ACCENT_COLORS,
  neutralFor,
  OUTFIT_ORDER,
  REST_DAYS,
  rotationWeight,
} from './generator';
import { OCCASION_HINTS } from './occasions';
import type {
  Formality,
  GarmentColor,
  GarmentRole,
  Pattern,
  Warmth,
} from './properties';

/**
 * The outfit generator (#9): templates, the pool as given, the hard rules
 * (colours, patterns, avoided pairs, saved outfits, locked garments), the
 * weather and formality as a score, rotation, and stable seeded pages.
 */

let nextId = 1;

function garment(
  role: GarmentRole,
  options: {
    colors?: GarmentColor[];
    pattern?: Pattern | null;
    formality?: Formality | null;
    warmth?: Warmth;
    idleDays?: number | null;
    waterResistant?: boolean;
  } = {},
): IdeaGarment {
  const warmth = options.warmth ?? (role === 'layer' ? 3 : 2);
  return {
    id: nextId++,
    role,
    colors: options.colors ?? ['black'],
    pattern: options.pattern ?? 'solid',
    formality: options.formality ?? null,
    weather: {
      role,
      warmth,
      waterResistant: options.waterResistant ?? false,
    },
    idleDays: options.idleDays === undefined ? 5 : options.idleDays,
  };
}

/** A small, plain closet: 4 tops, 3 bottoms, 2 shoes. */
function closet(): IdeaGarment[] {
  return [
    garment('top', { colors: ['white'] }),
    garment('top', { colors: ['grey'] }),
    garment('top', { colors: ['black'] }),
    garment('top', { colors: ['beige'] }),
    garment('bottom', { colors: ['blue'] }),
    garment('bottom', { colors: ['black'] }),
    garment('bottom', { colors: ['beige'] }),
    garment('footwear', { colors: ['white'] }),
    garment('footwear', { colors: ['brown'] }),
  ];
}

/** A day at `feelsLike` °C every hour. */
function steadyDay(feelsLike: number, rain = false): DayForecast {
  return {
    day: '2026-09-26',
    code: rain ? 63 : 1,
    high: feelsLike,
    low: feelsLike,
    precipitationChance: rain ? 80 : 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike,
      precipitationChance: rain ? 80 : 0,
      code: rain ? 63 : 1,
    })),
  };
}

function needsAt(feelsLike: number): WeatherNeeds {
  return weatherNeeds(steadyDay(feelsLike), 'all-day', 0)!;
}

function page(request: Partial<IdeaRequest> & { pool: IdeaGarment[] }) {
  return generateIdeas({ seed: 1, offset: 0, limit: 10, ...request });
}

const ids = (idea: Idea) => idea.garments.map((g) => g.id);
const roles = (idea: Idea) => idea.garments.map((g) => g.role);

describe('generateIdeas', () => {
  it('fills a template: top, bottom and footwear, in outfit order', () => {
    const { ideas } = page({ pool: closet() });
    expect(ideas).toHaveLength(10);
    for (const idea of ideas) {
      expect(roles(idea)).toEqual(['top', 'bottom', 'footwear']);
      expect(idea.score).toBe(0);
      expect(idea.problems).toEqual([]);
    }
  });

  it('never repeats a combination', () => {
    const { ideas } = page({ pool: closet(), limit: 50 });
    // 4 tops x 3 bottoms x 2 shoes: every combination once, then no more.
    expect(ideas).toHaveLength(24);
    expect(new Set(ideas.map((idea) => keyOf(idea.garments))).size).toBe(24);
  });

  it('is a function of the pool as a set: the rows in another order give the same ideas', () => {
    const pool = closet();
    const shuffled = [...pool.slice(4), ...pool.slice(0, 4)].reverse();
    expect(
      generateIdeas({ seed: 7, pool: shuffled, offset: 0, limit: 8 }).ideas.map(
        ids,
      ),
    ).toEqual(
      generateIdeas({ seed: 7, pool, offset: 0, limit: 8 }).ideas.map(ids),
    );
  });

  it('pages are stable for a seed and differ across seeds', () => {
    const pool = closet();
    const whole = generateIdeas({ seed: 7, pool, offset: 0, limit: 12 });
    const pages = [0, 4, 8].map(
      (offset) => generateIdeas({ seed: 7, pool, offset, limit: 4 }).ideas,
    );
    expect(pages.flat().map(ids)).toEqual(whole.ideas.map(ids));
    // Asked again, and after a later page was read: the same page.
    expect(generateIdeas({ seed: 7, pool, offset: 4, limit: 4 })).toEqual(
      generateIdeas({ seed: 7, pool, offset: 4, limit: 4 }),
    );
    expect(pages[0].map(ids)).not.toEqual(
      generateIdeas({ seed: 8, pool, offset: 0, limit: 4 }).ideas.map(ids),
    );
  });

  it('says when another page follows', () => {
    const pool = closet();
    expect(generateIdeas({ seed: 1, pool, offset: 20, limit: 4 }).more).toBe(
      false,
    );
    expect(generateIdeas({ seed: 1, pool, offset: 16, limit: 4 }).more).toBe(
      true,
    );
    expect(
      generateIdeas({ seed: 1, pool, offset: 24, limit: 4 }).ideas,
    ).toEqual([]);
  });

  it('draws only from the pool, and never accessories, bags or uncategorised garments', () => {
    const pool = [
      ...closet(),
      garment('accessory'),
      garment('bag'),
      garment('none'),
    ];
    const allowed = new Set(
      pool.filter((g) => !['accessory', 'bag', 'none'].includes(g.role)),
    );
    const { ideas } = page({ pool, limit: 30 });
    for (const idea of ideas) {
      for (const worn of idea.garments) expect(allowed.has(worn)).toBe(true);
    }
  });

  it('with a locked garment (?with=), every idea holds it', () => {
    const pool = closet();
    const jeans = pool[4];
    const { ideas } = page({ pool, locked: [jeans], limit: 30 });
    expect(ideas).toHaveLength(8); // 4 tops x 2 shoes
    for (const idea of ideas) expect(ids(idea)).toContain(jeans.id);
  });

  it('a locked accessory rides along; a locked garment outside the pool still appears', () => {
    const pool = closet();
    const watch = garment('accessory');
    const dirtyTee = garment('top', { colors: ['white'] });
    const { ideas } = page({ pool, locked: [watch, dirtyTee], limit: 30 });
    expect(ideas.length).toBeGreaterThan(0);
    for (const idea of ideas) {
      expect(ids(idea)).toContain(watch.id);
      expect(ids(idea)).toContain(dirtyTee.id);
      expect(roles(idea)).toEqual(['top', 'bottom', 'footwear', 'accessory']);
    }
  });

  it('never puts an avoided pair together', () => {
    const pool = closet();
    const [white, , , , blueBottom] = pool;
    const { ideas } = page({
      pool,
      avoid: [[blueBottom.id, white.id]],
      limit: 50,
    });
    expect(ideas).toHaveLength(22); // 24 less the two shoes with that pair
    for (const idea of ideas) {
      expect(
        ids(idea).includes(white.id) && ids(idea).includes(blueBottom.id),
      ).toBe(false);
    }
  });

  it('skips a combination equal to a saved outfit, compared on what it draws', () => {
    const pool = closet();
    const [tee, , , , jeans, , , sneakers] = pool;
    const belt = garment('accessory');
    const { ideas } = page({
      pool,
      saved: [[tee, jeans, sneakers, belt]],
      limit: 50,
    });
    expect(ideas).toHaveLength(23);
    expect(ideas.map((idea) => keyOf(idea.garments))).not.toContain(
      keyOf([tee, jeans, sneakers]),
    );
  });

  it(`keeps to ${MAX_ACCENT_COLORS} colours beyond the neutrals and one pattern`, () => {
    const pool = [
      garment('top', { colors: ['red'] }),
      garment('top', { colors: ['white'], pattern: 'stripes' }),
      garment('bottom', { colors: ['green'] }),
      garment('bottom', { colors: ['black'], pattern: 'check' }),
      garment('footwear', { colors: ['yellow'] }),
      garment('footwear', { colors: ['white'] }),
    ];
    const { ideas } = page({ pool, limit: 50 });
    // red + green + yellow and stripes + check never; the rest go.
    expect(ideas).toHaveLength(5);
    for (const idea of ideas)
      expect(colorsGoTogether(idea.garments)).toBe(true);
  });

  it('counts a colour once however many garments carry it', () => {
    expect(
      colorsGoTogether([
        { role: 'layer', colors: ['blue'], pattern: null },
        { role: 'top', colors: ['blue', 'white'], pattern: 'solid' },
        { role: 'top', colors: ['green'], pattern: null },
      ]),
    ).toBe(true);
    expect(
      colorsGoTogether([
        { role: 'top', colors: ['pattern', 'blue'], pattern: null },
        { role: 'bottom', colors: ['white'], pattern: 'floral' },
      ]),
    ).toBe(false);
  });

  it('counts blue as a neutral on bottoms only (jeans go with anything)', () => {
    expect(neutralFor('bottom', 'blue')).toBe(true);
    expect(neutralFor('top', 'blue')).toBe(false);
    expect(neutralFor('layer', 'blue')).toBe(false);
    expect(neutralFor('top', 'grey')).toBe(true);
    expect(neutralFor('bottom', 'green')).toBe(false);
    // A red tee under a green jacket, with jeans: two colours, fine.
    type Worn = Parameters<typeof colorsGoTogether>[0][number];
    const jeans: Worn = { role: 'bottom', colors: ['blue'], pattern: null };
    const redTee: Worn = { role: 'top', colors: ['red'], pattern: null };
    const greenJacket: Worn = {
      role: 'layer',
      colors: ['green'],
      pattern: null,
    };
    expect(colorsGoTogether([greenJacket, redTee, jeans])).toBe(true);
    // The same blue as a shirt is a third colour.
    expect(
      colorsGoTogether([greenJacket, redTee, { ...jeans, role: 'top' }]),
    ).toBe(false);
  });

  it('uses the one-piece template, and footwear only when the closet has some', () => {
    const dress = garment('one-piece', { colors: ['blue'] });
    const tee = garment('top');
    const shorts = garment('bottom');
    const withShoes = page({
      pool: [dress, tee, shorts, garment('footwear')],
      limit: 10,
    });
    expect(withShoes.ideas.map(roles)).toContainEqual([
      'one-piece',
      'footwear',
    ]);
    const noShoes = page({ pool: [dress, tee, shorts], limit: 10 });
    expect(noShoes.ideas.map(roles).sort()).toEqual([
      ['one-piece'],
      ['top', 'bottom'],
    ]);
  });

  it('has no ideas without a template to fill', () => {
    expect(page({ pool: [garment('top'), garment('footwear')] })).toEqual({
      ideas: [],
      more: false,
    });
    // A locked dress rules out separates.
    expect(
      page({ pool: closet(), locked: [garment('one-piece')] }).ideas.map(roles),
    ).toEqual([
      ['one-piece', 'footwear'],
      ['one-piece', 'footwear'],
    ]);
  });

  describe('weather', () => {
    const coat = () => garment('layer', { warmth: 4, colors: ['black'] });

    it('adds a layer when it is cold, and none when it is warm', () => {
      const pool = [...closet(), coat()];
      const cold = page({ pool, needs: needsAt(6) });
      for (const idea of cold.ideas) expect(roles(idea)[0]).toBe('layer');
      const warm = page({ pool, needs: needsAt(22) });
      for (const idea of warm.ideas) expect(roles(idea)).not.toContain('layer');
    });

    it('never adds a layer without a forecast', () => {
      const { ideas } = page({ pool: [...closet(), coat()], limit: 30 });
      for (const idea of ideas) expect(roles(idea)).not.toContain('layer');
    });

    it('puts ideas that fit first, then near misses best first, their problems named', () => {
      const pool = [
        garment('top', { warmth: 2 }),
        garment('top', { warmth: 5, colors: ['grey'] }),
        garment('bottom', { warmth: 2 }),
        garment('footwear', { warmth: 2 }),
      ];
      const { ideas } = page({ pool, needs: needsAt(22) });
      expect(ideas.map((idea) => idea.score)).toEqual([0, 2]);
      expect(ideas[1].problems).toEqual(['too-warm']);
    });

    it('asks for water resistance in the rain', () => {
      const rain = weatherNeeds(steadyDay(18, true), 'all-day', 0)!;
      const boots = garment('footwear', { waterResistant: true });
      const pool = [garment('top'), garment('bottom'), garment('footwear')];
      const dry = page({ pool: [...pool, boots], needs: rain });
      expect(ids(dry.ideas[0])).toContain(boots.id);
      expect(dry.ideas[1].problems).toContain('needs-water-resistance');
    });
  });

  describe('formality', () => {
    it("prefers the occasion's range and names a miss", () => {
      const work = OCCASION_HINTS.work.formality;
      const pool = [
        garment('top', { formality: 3 }),
        garment('top', { formality: 1, colors: ['grey'] }),
        garment('bottom', { formality: 3 }),
        garment('footwear', { formality: 3 }),
      ];
      const { ideas } = page({ pool, formality: work });
      expect(ideas.map((idea) => idea.score)).toEqual([0, 2]);
      expect(ideas[1].problems).toEqual(['too-casual']);
      const lounge = page({
        pool,
        formality: OCCASION_HINTS.workout.formality,
      });
      expect(lounge.ideas[0].problems).toEqual(['too-dressy']);
    });
  });

  describe('rotation', () => {
    it('favours what has been worn least recently', () => {
      const rested = garment('top', { idleDays: null, colors: ['white'] });
      const worn = garment('top', { idleDays: 0, colors: ['grey'] });
      expect(rotationWeight(rested)).toBeGreaterThan(rotationWeight(worn));
      const pool = [
        rested,
        worn,
        ...Array.from({ length: 12 }, () => garment('bottom')),
        garment('footwear'),
      ];
      // The first ideas of many seeds: the rested tee leads far more often.
      let restedFirst = 0;
      for (let seed = 0; seed < 200; seed += 1) {
        const [first] = generateIdeas({
          seed,
          pool,
          offset: 0,
          limit: 1,
        }).ideas;
        if (ids(first).includes(rested.id)) restedFirst += 1;
      }
      expect(restedFirst).toBeGreaterThan(140);
    });

    it(`marks garments unworn ${REST_DAYS} days or more as rested`, () => {
      const tee = garment('top', { idleDays: REST_DAYS });
      const jeans = garment('bottom', { idleDays: null });
      const shoes = garment('footwear', { idleDays: 3 });
      const [idea] = page({ pool: [tee, jeans, shoes] }).ideas;
      expect(idea.rested).toEqual([tee.id, jeans.id]);
    });
  });

  it('lists garments in OUTFIT_ORDER', () => {
    expect(OUTFIT_ORDER.slice(0, 5)).toEqual([
      'layer',
      'one-piece',
      'top',
      'bottom',
      'footwear',
    ]);
  });
});
