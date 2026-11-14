import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../calendar-date';
import { seededRandom } from '../random';
import { loadPersona } from '../seed/persona';
import {
  DRAWN_ROLES,
  generateIdeas,
  type Idea,
  type IdeaGarment,
} from '../wardrobe/generator';
import {
  occasionDemands,
  type Occasion,
  OCCASIONS,
} from '../wardrobe/occasions';
import type { DayForecast } from './forecast';
import { assessOutfit, matchGarment, weatherNeeds } from './match';

/**
 * Whether the ideas are wearable on real days (#645): the demo closet
 * (Theo's bible, as the seed writes it) through the generator on five real
 * New York days, one per season. match.spec.ts pins each rule on its own;
 * this pins what the rules add up to over a real closet, which is where a
 * miscalibrated rule shows (one pair of jeans in every January idea, no
 * office outfit fitting at all).
 *
 * The days: Open-Meteo's archive (ERA5) hourly apparent temperature at
 * Central Park (40.78,-73.97) in America/New_York, 2025, each the month's
 * median daytime feels-like among its dry days (October's the one nearest
 * 15 °C), dry; and one rainy July day (#648), 2025-07-14, the day of
 * that summer's flash floods, with its hourly precipitation too.
 */

const HOURLY_FEELS_LIKE: Record<string, readonly number[]> = {
  // 18 to 27 °F through the day: an ordinary January day.
  '2025-01-27': [
    -7.9, -7.8, -7.6, -7.4, -7.4, -7.7, -8.4, -9.2, -7.9, -6.2, -5.2, -4.3,
    -4.1, -3.6, -3.3, -3.2, -3.7, -4.8, -5.6, -6.0, -5.6, -5.5, -5.0, -4.9,
  ],
  // 46 to 57 °F from 8:00: a layer that comes off by the afternoon.
  '2025-04-14': [
    4.9, 4.2, 3.7, 3.3, 2.9, 2.6, 3.0, 4.9, 7.6, 9.5, 11.0, 10.8, 10.4, 12.2,
    13.3, 13.5, 13.8, 12.1, 10.6, 9.0, 8.5, 8.4, 9.2, 9.5,
  ],
  // 83 to 95 °F: a heat wave's ordinary day.
  '2025-07-06': [
    24.8, 24.1, 23.4, 23.0, 22.8, 23.0, 23.9, 25.6, 28.2, 30.2, 32.3, 33.9,
    35.0, 35.1, 34.4, 33.5, 32.7, 32.6, 32.4, 31.5, 30.1, 30.5, 29.7, 29.4,
  ],
  // 81 to 97 °F with thunderstorms from 13:00: a hot rainy day.
  '2025-07-14': [
    27.5, 27.3, 27.3, 27.6, 27.8, 27.7, 28.1, 29.5, 31.3, 31.3, 32.6, 35.5,
    36.0, 31.9, 31.9, 31.0, 33.3, 29.9, 28.2, 29.1, 29.3, 29.2, 28.5, 27.9,
  ],
  // 51 to 64 °F, about 15 °C across the day.
  '2025-10-01': [
    14.4, 13.2, 11.8, 10.8, 9.9, 9.4, 8.9, 9.9, 10.7, 12.2, 14.0, 15.7, 16.8,
    17.6, 17.5, 16.8, 16.1, 15.5, 14.4, 14.1, 13.0, 12.0, 11.4, 10.6,
  ],
};

/** The archive's hourly precipitation (mm) on the rainy days. */
const HOURLY_PRECIPITATION: Record<string, readonly number[]> = {
  '2025-07-14': [
    0.0, 0.0, 0.6, 0.1, 0.0, 0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.0, 0.0, 2.4, 1.4,
    3.8, 0.3, 6.1, 2.5, 0.2, 2.1, 1.0, 1.4, 1.1,
  ],
};

/**
 * The archive records what fell, not a chance: an hour that had a wet
 * hour's rain (0.5 mm or more) reads as a forecast certain of it, the rest
 * as dry.
 */
const WET_HOUR_MM = 0.5;

function realDay(day: IsoDate): DayForecast {
  const feels = HOURLY_FEELS_LIKE[day];
  const rain = HOURLY_PRECIPITATION[day];
  const chance = (hour: number) =>
    rain && rain[hour] >= WET_HOUR_MM ? 100 : 0;
  const code = rain ? 61 : 1;
  return {
    day,
    code,
    // Not read by the matching: the hours' own extremes.
    high: Math.max(...feels),
    low: Math.min(...feels),
    precipitationChance: Math.max(...feels.map((_, hour) => chance(hour))),
    hours: feels.map((feelsLike, hour) => ({
      hour,
      feelsLike,
      precipitationChance: chance(hour),
      code: chance(hour) > 0 ? 61 : 1,
    })),
  };
}

const JANUARY = realDay('2025-01-27');
const APRIL = realDay('2025-04-14');
const JULY = realDay('2025-07-06');
const OCTOBER = realDay('2025-10-01');
const JULY_RAIN = realDay('2025-07-14');

interface DemoGarment extends IdeaGarment {
  name: string;
}

/**
 * What the generator draws from in the demo closet: the closet as the seed
 * writes it (archived and away garments out), every garment clean and never
 * worn (rotation is not what this asks), his clashes and saved outfits in.
 */
function demoCloset() {
  const demo = loadPersona('demo');
  const ids = new Map(demo.garments.map((g, n) => [g.id, n + 1]));
  const pool: DemoGarment[] = demo.garments
    .filter((g) => !g.archivedOn && !g.away && DRAWN_ROLES.includes(g.role))
    .map((g) => ({
      id: ids.get(g.id)!,
      name: g.fields.name ?? g.id,
      role: g.role,
      category: g.fields.category,
      type: g.fields.type ?? null,
      colors: g.fields.colors ?? [],
      pattern: g.fields.pattern ?? null,
      formality: g.fields.formality ?? null,
      weather: matchGarment({
        category: g.fields.category,
        type: g.fields.type ?? null,
        fabricWeight: g.fields.fabricWeight ?? null,
        warmth: g.fields.warmth ?? null,
        waterResistant: g.fields.waterResistant ?? false,
      }),
      idleDays: null,
    }));
  const byId = new Map(pool.map((g) => [g.id, g]));
  return {
    pool,
    avoid: demo.avoid.map(
      ([a, b]) => [ids.get(a)!, ids.get(b)!] as [number, number],
    ),
    saved: demo.outfits.map((outfit) =>
      outfit.garmentIds
        .map((id) => byId.get(ids.get(id)!))
        .filter((g) => g !== undefined),
    ),
    named: (name: string) => pool.find((g) => g.name === name)!,
  };
}

const CLOSET = demoCloset();

// Eight gallery openings, each its first page of six: what a person sees
// over a week or so of the same weather.
const random = seededRandom('real-days');
const SEEDS = Array.from({ length: 8 }, () =>
  Math.floor(random.next() * 2 ** 31),
);
const PAGE = 6;

/** The ideas that fit (score 0) on the first page of every seed. */
function fittingIdeas(day: DayForecast, occasion: Occasion) {
  const needs = weatherNeeds(day, occasion, 0);
  return SEEDS.flatMap((seed) =>
    generateIdeas({
      pool: CLOSET.pool,
      avoid: CLOSET.avoid,
      saved: CLOSET.saved,
      needs,
      ...occasionDemands(occasion),
      seed,
      offset: 0,
      limit: PAGE,
    }).ideas.filter((idea) => idea.score === 0),
  );
}

const distinct = (ideas: readonly Idea<DemoGarment>[], role: string) =>
  new Set(
    ideas.flatMap((idea) =>
      idea.garments.filter((g) => g.role === role).map((g) => g.name),
    ),
  );

/** How an outfit of the demo's garments, by name, scores on a day. */
function scoreOf(day: DayForecast, occasion: Occasion, names: string[]) {
  return assessOutfit(
    weatherNeeds(day, occasion, 0)!,
    names.map((name) => CLOSET.named(name).weather),
  );
}

describe('the ideas on real New York days (#645)', () => {
  describe('January, 18 to 27 °F', () => {
    it('varies the trousers and the shoes across the days', () => {
      const ideas = fittingIdeas(JANUARY, 'all-day');
      const bottoms = distinct(ideas, 'bottom');
      const shoes = distinct(ideas, 'footwear');
      expect(bottoms.size, [...bottoms].join(', ')).toBeGreaterThanOrEqual(3);
      expect(shoes.size, [...shoes].join(', ')).toBeGreaterThanOrEqual(2);
      expect(ideas.length).toBe(SEEDS.length * PAGE);
    });

    it('dresses him for the office', () => {
      expect(fittingIdeas(JANUARY, 'work').length).toBeGreaterThan(0);
    });

    it('still calls shorts and slides too cold', () => {
      expect(
        scoreOf(JANUARY, 'all-day', [
          'Oat cashmere crewneck',
          'Winter parka',
          'Khaki shorts',
          'Slides',
        ]).problems,
      ).toEqual(['legs-too-cold', 'feet-too-cold']);
    });
  });

  describe('April, 46 to 57 °F', () => {
    it('never fits a winter parka over a linen shirt', () => {
      const fit = scoreOf(APRIL, 'all-day', [
        'White linen shirt',
        'Winter parka',
        '501s',
        'White sneakers',
      ]);
      expect(fit.score).toBeGreaterThan(0);
      // The parka over a tee is a cold morning's choice that comes off.
      expect(
        scoreOf(APRIL, 'all-day', [
          'White tee',
          'Winter parka',
          '501s',
          'White sneakers',
        ]).score,
      ).toBe(0);
    });
  });

  describe('October, about 15 °C', () => {
    it('fits no idea with the winter parka', () => {
      const ideas = fittingIdeas(OCTOBER, 'all-day');
      expect(ideas.length).toBe(SEEDS.length * PAGE);
      expect(distinct(ideas, 'layer')).not.toContain('Winter parka');
      expect(
        scoreOf(OCTOBER, 'all-day', [
          'White tee',
          'Winter parka',
          '501s',
          'White sneakers',
        ]).problems,
      ).toEqual(['too-warm']);
    });
  });

  describe('July, 83 to 95 °F', () => {
    it('wears no boots in any idea that fits', () => {
      for (const occasion of ['all-day', 'work'] as const) {
        const shoes = fittingIdeas(JULY, occasion).flatMap((idea) =>
          idea.garments.filter((g) => g.role === 'footwear'),
        );
        expect(shoes.length).toBeGreaterThan(0);
        expect(shoes.filter((g) => g.weather.warmth >= 4)).toEqual([]);
      }
    });

    it('on a rainy day varies the tops and wants no shell (#648)', () => {
      const ideas = fittingIdeas(JULY_RAIN, 'all-day');
      const tops = distinct(ideas, 'top');
      expect(tops.size, [...tops].join(', ')).toBeGreaterThanOrEqual(3);
      expect(ideas.length).toBe(SEEDS.length * PAGE);
      expect(distinct(ideas, 'layer')).toEqual(new Set());
      const needs = weatherNeeds(JULY_RAIN, 'all-day', 0)!;
      expect(needs).toMatchObject({ rain: true, umbrella: true, layer: false });
    });

    it('calls suede boots with shorts too warm for the feet', () => {
      expect(
        scoreOf(JULY, 'all-day', [
          'White tee',
          'Khaki shorts',
          'Suede Chelsea boots',
        ]).problems,
      ).toEqual(['feet-too-warm']);
    });
  });
});

/** A day at `feelsLike` °C every hour, dry: a workout's two ends. */
function steadyDay(feelsLike: number): DayForecast {
  return {
    day: '2025-01-01',
    code: 1,
    high: feelsLike,
    low: feelsLike,
    precipitationChance: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike,
      precipitationChance: 0,
      code: 1,
    })),
  };
}

/** Every idea on the first page of every seed, near misses included: what the planner may take. */
function allIdeas(day: DayForecast, occasion: Occasion) {
  const needs = weatherNeeds(day, occasion, 0);
  return SEEDS.flatMap(
    (seed) =>
      generateIdeas({
        pool: CLOSET.pool,
        avoid: CLOSET.avoid,
        saved: CLOSET.saved,
        needs,
        ...occasionDemands(occasion),
        seed,
        offset: 0,
        limit: PAGE,
      }).ideas,
  );
}

// Named here, not read from properties.ts: the spec's own answer to what a
// run is dressed in.
const RUNNING_FOOTWEAR = ['running-shoes'];
const RUNNING_BOTTOMS = ['running-shorts', 'leggings', 'joggers'];

describe('a workout in the demo closet (#647)', () => {
  it.each([
    ['January, about -8 °C at 7 am', JANUARY],
    ['July, about 26 °C at 7 am', JULY],
    ['0 °C', steadyDay(0)],
    ['30 °C', steadyDay(30)],
  ] as const)(
    '%s: every idea has running shoes and athletic bottoms',
    (_, day) => {
      const ideas = allIdeas(day, 'workout');
      expect(ideas.length).toBeGreaterThan(0);
      const dressedFor = (g: DemoGarment, role: string, types: string[]) =>
        g.role === role && g.type !== null && types.includes(g.type);
      const offending = ideas
        .filter(
          (idea) =>
            !idea.garments.some((g) =>
              dressedFor(g, 'footwear', RUNNING_FOOTWEAR),
            ) ||
            !idea.garments.some((g) =>
              dressedFor(g, 'bottom', RUNNING_BOTTOMS),
            ),
        )
        .map((idea) => idea.garments.map((g) => g.name).join(' + '));
      expect(offending).toEqual([]);
    },
  );

  it('holds a run to no cold floor on the legs and feet, and its layer to no formality', () => {
    const run = ['Running tee', 'Running shorts', 'Running shoes'];
    expect(scoreOf(JANUARY, 'all-day', run).problems).toContain(
      'legs-too-cold',
    );
    expect(scoreOf(JANUARY, 'workout', run).problems).toEqual(['too-cold']);
    // The cold run wears a layer (none is formality 1), and an idea is too
    // dressy only for what is under it.
    const ideas = allIdeas(JANUARY, 'workout');
    expect(
      ideas.every((idea) => idea.garments.some((g) => g.role === 'layer')),
    ).toBe(true);
    const dressyForTheLayer = ideas.filter(
      (idea) =>
        idea.problems.includes('too-dressy') &&
        idea.garments.every(
          (g) => g.role === 'layer' || (g.formality ?? 1) <= 1,
        ),
    );
    expect(dressyForTheLayer).toEqual([]);
    expect(ideas.some((idea) => !idea.problems.includes('too-dressy'))).toBe(
      true,
    );
  });

  it('asks full-length bottoms again in a cold snap, and spares shorts at 0 °C', () => {
    // The planner takes an idea's best (first) of each seed: that is what
    // a slot is dressed in.
    const bestBottoms = (day: DayForecast) =>
      SEEDS.map((seed) => {
        const [best] = generateIdeas({
          pool: CLOSET.pool,
          avoid: CLOSET.avoid,
          saved: CLOSET.saved,
          needs: weatherNeeds(day, 'workout', 0),
          ...occasionDemands('workout'),
          seed,
          offset: 0,
          limit: PAGE,
        }).ideas;
        return best.garments.find((g) => g.role === 'bottom')?.type;
      });
    expect(bestBottoms(steadyDay(0))).toContain('running-shorts');
    expect(bestBottoms(steadyDay(-20))).not.toContain('running-shorts');
    expect(allIdeas(steadyDay(-20), 'workout').length).toBeGreaterThan(0);
  });

  it('fits a hot morning run outright', () => {
    expect(fittingIdeas(steadyDay(30), 'workout').length).toBeGreaterThan(0);
  });
});

describe('swimwear (#647)', () => {
  it('is in no idea for any occasion, in any season', () => {
    expect(CLOSET.pool.some((g) => g.type === 'swimwear')).toBe(true);
    for (const day of [JANUARY, APRIL, JULY, JULY_RAIN, OCTOBER]) {
      for (const occasion of OCCASIONS) {
        const swim = allIdeas(day, occasion).flatMap((idea) =>
          idea.garments.filter((g) => g.type === 'swimwear').map((g) => g.name),
        );
        expect(swim, `${day.day} ${occasion}`).toEqual([]);
      }
    }
  });
});
