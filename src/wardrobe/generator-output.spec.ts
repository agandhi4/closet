import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../random';
import type { DayForecast } from '../weather/forecast';
import { weatherNeeds, type WeatherNeeds } from '../weather/match';
import {
  generateIdeas,
  type IdeaGarment,
  type IdeaPage,
  NEUTRAL_COLORS,
} from './generator';
import { goesWith, outfitCount } from './goes-with';
import { OCCASION_HINTS } from './occasions';
import {
  builtInCategoriesOf,
  type Formality,
  GARMENT_COLORS,
  type GarmentColor,
  type GarmentRole,
  PATTERNS,
  type Warmth,
  WARMTHS,
} from './properties';

/**
 * The generator's exact output for seeded input (#168): pinned so a change
 * made for speed (when to stop drawing, what to skip) is proven to change
 * no idea, no order, no score and no `more`. A failure here means the ideas
 * people see changed: if that is intended, bump GENERATOR_VERSION and
 * re-pin; if it is not, the change was not only for speed.
 */

// Mostly neutrals and everyday formality, as a closet is: enough ideas fit
// that a page fills early, and enough do not that others run out of draws.
const COLORS: readonly GarmentColor[] = [
  ...GARMENT_COLORS,
  ...NEUTRAL_COLORS,
  ...NEUTRAL_COLORS,
];
const FORMALITY: readonly Formality[] = [1, 2, 2, 2, 3, 3, 3, 4];

/** A closet like a person's: every drawn role, colours, patterns, formality, wears. */
function closet(key: string, counts: Partial<Record<GarmentRole, number>>) {
  const random = seededRandom('generator-output', key);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random.next() * values.length)];
  const garments: IdeaGarment[] = [];
  let id = 100;
  for (const [role, count] of Object.entries(counts) as [
    GarmentRole,
    number,
  ][]) {
    for (let n = 0; n < count; n += 1) {
      const colors: GarmentColor[] = [pick(COLORS)];
      if (random.chance(0.3)) colors.push(pick(COLORS));
      garments.push({
        id: (id += 1 + Math.floor(random.next() * 3)),
        role,
        category: builtInCategoriesOf(role)[0],
        type: null,
        colors: [...new Set(colors)],
        pattern: random.chance(0.7) ? 'solid' : pick(PATTERNS),
        formality: random.chance(0.1) ? null : pick(FORMALITY),
        weather: {
          role,
          warmth: pick(WARMTHS),
          waterResistant: random.chance(0.15),
          rainGear: false,
        },
        idleDays: random.chance(0.2) ? null : Math.floor(random.next() * 90),
      });
    }
  }
  // Out of id order, as a query's rows may come.
  return garments.reverse();
}

function day(feelsLike: number, rain: boolean): DayForecast {
  return {
    day: '2026-09-26',
    code: rain ? 63 : 1,
    high: feelsLike + 4,
    low: feelsLike - 4,
    precipitationChance: rain ? 80 : 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike: feelsLike - 4 + Math.round((8 * hour) / 23),
      precipitationChance: rain ? 80 : 0,
      code: rain ? 63 : 1,
    })),
  };
}

const COLD: WeatherNeeds = weatherNeeds(day(6, true), 'all-day', 0)!;
const MILD: WeatherNeeds = weatherNeeds(day(16, false), 'evening', 0)!;

const PERSON = closet('person', {
  layer: 9,
  'one-piece': 5,
  top: 24,
  bottom: 12,
  footwear: 8,
  accessory: 4,
});
const SMALL = closet('small', { top: 3, bottom: 2, footwear: 2, layer: 2 });

const byRole = (pool: readonly IdeaGarment[], role: GarmentRole) =>
  pool.filter((g) => g.role === role).sort((a, b) => a.id - b.id);

/** Pairs of drawn garments never to combine, and outfits already saved. */
function history(pool: readonly IdeaGarment[]) {
  const [tops, bottoms, shoes] = (['top', 'bottom', 'footwear'] as const).map(
    (role) => byRole(pool, role),
  );
  return {
    avoid: [
      [tops[0].id, bottoms[0].id],
      [tops[3].id, shoes[1].id],
      [bottoms[2].id, shoes[0].id],
    ] as [number, number][],
    saved: [0, 1, 2, 3, 4, 5].map((n) => [
      tops[n],
      bottoms[n % bottoms.length],
      shoes[n % shoes.length],
    ]),
  };
}

/** An idea as one line: ids top to toe, score, problems, rested ids. */
function digest(page: IdeaPage): string[] {
  return [
    ...page.ideas.map(
      (idea) =>
        `${idea.garments.map((g) => g.id).join('+')} ${idea.score} ${idea.problems.join('/') || '-'} ${idea.rested.join('+') || '-'}`,
    ),
    `more ${page.more}`,
  ];
}

const hashOf = (lines: readonly string[]) =>
  createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);

describe('the generator, pinned (#168)', () => {
  const { avoid, saved } = history(PERSON);
  const gallery = {
    pool: PERSON,
    avoid,
    saved,
    formality: OCCASION_HINTS['all-day'].formality,
  };

  it('a page that fills before the draws run out', () => {
    const page = generateIdeas({ ...gallery, seed: 7, offset: 0, limit: 6 });
    expect(digest(page)).toEqual(PINNED.fills);
  });

  it('a gallery page in the cold, and its later pages', () => {
    const first = generateIdeas({
      ...gallery,
      seed: 7,
      needs: COLD,
      offset: 0,
      limit: 6,
    });
    expect(digest(first)).toEqual(PINNED.coldFirst);
    const third = generateIdeas({
      ...gallery,
      seed: 7,
      needs: COLD,
      offset: 12,
      limit: 6,
    });
    expect(digest(third)).toEqual(PINNED.coldThird);
  });

  it('a page past what fits: the near misses, best first', () => {
    const page = generateIdeas({
      ...gallery,
      seed: 7,
      needs: MILD,
      formality: OCCASION_HINTS.evening.formality,
      offset: 294,
      limit: 6,
    });
    expect(digest(page)).toEqual(PINNED.nearMisses);
  });

  // Locks that clash flag their ideas instead (#21): generator.spec.ts.
  it('with a garment locked', () => {
    const [top] = byRole(PERSON, 'top');
    const locked = generateIdeas({
      ...gallery,
      seed: 3,
      needs: COLD,
      locked: [top],
      offset: 0,
      limit: 6,
    });
    expect(digest(locked)).toEqual(PINNED.locked);
  });

  it('a closet small enough to draw every combination', () => {
    const page = generateIdeas({
      pool: SMALL,
      seed: 11,
      needs: COLD,
      offset: 0,
      limit: 50,
    });
    expect(digest(page)).toEqual(PINNED.small);
  });

  it('"Goes with my closet" for each layer and top as the item', () => {
    const lines = [...byRole(PERSON, 'layer'), ...byRole(PERSON, 'top')]
      .slice(0, 16)
      .flatMap((item) => {
        const closetOf = PERSON.filter((g) => g.id !== item.id);
        const request = {
          item,
          closet: closetOf,
          avoid,
          rules: [],
          seed: item.id,
        };
        const found = goesWith(request);
        return [
          `${item.id}: ${found.outfits}${found.capped ? '+' : ''}`,
          ...found.best.map((idea) => idea.garments.map((g) => g.id).join('+')),
          ...found.roles.map(
            (role) =>
              `${role.role} ${role.goes}/${role.of} ${role.best.map((p) => `${p.garment.id}${p.atFormality ? '*' : ''}:${p.outfits ?? '-'}`).join(',')}`,
          ),
          `count ${JSON.stringify(outfitCount(request))}`,
        ];
      });
    expect(hashOf(lines)).toBe(PINNED.goesWith);
  });

  it('a sweep of seeds, pages, weather and locks', () => {
    const [top] = byRole(PERSON, 'top');
    const [dress] = byRole(PERSON, 'one-piece');
    // Every combination, in the order the pin was recorded in.
    const requests = [1, 2, 3, 99, 2_147_483_647].flatMap((seed) =>
      [null, COLD, MILD].flatMap((needs) =>
        [[], [top], [dress]].flatMap((locked) =>
          [0, 6, 60, 294].map((offset) => ({ seed, needs, locked, offset })),
        ),
      ),
    );
    const lines = requests.flatMap((varied) =>
      digest(generateIdeas({ ...gallery, ...varied, limit: 6 })),
    );
    expect(hashOf(lines)).toBe(PINNED.sweep);
  });
});

describe('the layer, drawn like the other roles (#646)', () => {
  // About 9 to 13 °C through the day: a tee alone is too cold, and each of
  // these five layers fits over every top. The one unworn since winter is
  // the most rested, which once put it on every card.
  const SPRING = weatherNeeds(day(10, false), 'all-day', 0)!;
  let id = 0;
  const garment = (
    role: GarmentRole,
    warmth: Warmth,
    idleDays = 2,
  ): IdeaGarment => ({
    id: (id += 1),
    role,
    category: builtInCategoriesOf(role)[0],
    type: null,
    colors: ['grey'],
    pattern: 'solid',
    formality: 2,
    weather: { role, warmth, waterResistant: false, rainGear: false },
    idleDays,
  });
  const pool = [
    garment('layer', 2, 90),
    garment('layer', 3, 20),
    garment('layer', 3, 30),
    garment('layer', 4, 12),
    garment('layer', 4, 40),
    ...([2, 2, 2, 2, 2, 3] as const).map((warmth) => garment('top', warmth)),
    ...([3, 3, 3] as const).map((warmth) => garment('bottom', warmth)),
    ...([2, 2] as const).map((warmth) => garment('footwear', warmth)),
  ];
  // A dozen gallery openings, each its first page.
  const layersOn = (garments: readonly IdeaGarment[], seed: number) =>
    generateIdeas({
      pool: garments,
      needs: SPRING,
      formality: OCCASION_HINTS['all-day'].formality,
      seed,
      offset: 0,
      limit: 6,
    }).ideas.map((idea) => {
      expect(idea.score).toBe(0);
      return idea.garments.find((g) => g.role === 'layer')!.id;
    });
  const pages = Array.from({ length: 12 }, (_, seed) => layersOn(pool, seed));

  it('puts no layer on more than half of the ideas', () => {
    const layers = pages.flat();
    expect(layers).toHaveLength(72);
    for (const layer of new Set(layers)) {
      const share = layers.filter((l) => l === layer).length;
      expect(share, `layer ${layer}`).toBeLessThanOrEqual(layers.length / 2);
    }
  });

  // `seed --reset` gives every garment a new id in the same order: the
  // layer's sequence is keyed by places, not ids (seed.spec.ts's --reset).
  it('draws the same layers when every id moves, as a reseed does', () => {
    const moved = pool.map((g) => ({ ...g, id: g.id + 500 }));
    expect(layersOn(moved, 3).map((layer) => layer - 500)).toEqual(pages[3]);
  });

  it('puts more than one layer on every page', () => {
    for (const page of pages) {
      expect(new Set(page).size, page.join(',')).toBeGreaterThan(1);
    }
  });
});

// First recorded before #168 changed when it stops drawing; re-pinned at
// GENERATOR_VERSION 2 for #645's limb and layer rules, at 3 for #646's
// layer drawn by rotation, and at 4 for #648's rain left to the umbrella.
const PINNED = {
  fills: [
    '120+214 0 - 120+214',
    '140+186+211 0 - 140+186+211',
    '155+199+215 0 - 155+199+215',
    '149+181+214 0 - 149+181+214',
    '148+183+214 0 - 183+214',
    '123+214 0 - 123+214',
    'more true',
  ],
  coldFirst: [
    '119+178+202+207 1 too-dressy 178+202+207+119',
    '103+178+181+207 1 too-dressy 178+181+207+103',
    '119+178+186+207 1 too-dressy 178+186+207+119',
    '102+123+207 1 too-dressy 123+207+102',
    '102+148+186+207 1 too-dressy 186+207+102',
    '119+149+192+207 1 too-dressy 149+192+207+119',
    'more true',
  ],
  coldThird: [
    '105+173+189+207 1 too-dressy 173+189+207+105',
    '102+134+192+207 1 too-dressy 134+192+207+102',
    '119+131+202+207 1 too-dressy 131+202+207+119',
    '103+131+192+207 1 too-dressy 131+192+207+103',
    '102+133+192+207 1 too-dressy 133+192+207+102',
    '102+144+192+207 1 too-dressy 144+192+207+102',
    'more true',
  ],
  nearMisses: [
    '133+186+214 1 legs-too-warm 133+186+214',
    '133+202+214 1 too-casual 133+202+214',
    '148+196+214 1 too-casual 196+214',
    '152+191+215 1 too-warm 152+191+215',
    '178+183+211 1 too-casual 178+183+211',
    '149+189+217 1 too-casual 149+189',
    'more true',
  ],
  locked: [
    '105+131+183+207 1 too-dressy 131+183+207+105',
    '103+131+186+207 1 too-dressy 131+186+207+103',
    '119+131+202+207 1 too-dressy 131+202+207+119',
    '119+131+192+207 1 too-dressy 131+192+207+119',
    '103+131+189+207 1 too-dressy 131+189+207+103',
    '119+131+194+207 2 legs-too-cold/too-dressy 131+194+207+119',
    'more true',
  ],
  small: [
    '115+105+108+112 1 too-cold 105+108+112+115',
    '115+105+110+112 1 too-cold 105+110+112+115',
    '103+110+112 2 needs-water-resistance 103+110+112',
    '117+107+110+112 2 needs-water-resistance 107+110+112+117',
    '103+108+112 2 needs-water-resistance 103+108+112',
    '103+108+113 2 needs-water-resistance 103+108+113',
    '103+110+113 2 needs-water-resistance 103+110+113',
    '117+107+108+112 2 needs-water-resistance 107+108+112+117',
    '107+110+113 4 too-cold/needs-water-resistance 107+110+113',
    '107+108+113 4 too-cold/needs-water-resistance 107+108+113',
    'more false',
  ],
  goesWith: '207d6aae6d946a9a',
  sweep: '35cecb1a8fce19d8',
};
