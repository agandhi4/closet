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

// First recorded before #168 changed when it stops drawing; re-pinned at
// GENERATOR_VERSION 2 for #645's limb and layer rules.
const PINNED = {
  fills: [
    '161+183+215 0 - 161+183+215',
    '145+191+211 0 - 145+191+211',
    '124+215 0 - 124+215',
    '126+217 0 - 126',
    '137+192+215 0 - 137+192+215',
    '124+211 0 - 124+211',
    'more true',
  ],
  coldFirst: [
    '102+178+183+207 1 too-dressy 178+183+207+102',
    '102+143+181+207 1 too-dressy 143+181+207+102',
    '102+134+183+207 1 too-dressy 134+183+207+102',
    '102+161+189+207 1 too-dressy 161+189+207+102',
    '102+144+186+207 1 too-dressy 144+186+207+102',
    '102+133+186+207 1 too-dressy 133+186+207+102',
    'more true',
  ],
  coldThird: [
    '102+173+192+207 1 too-dressy 173+192+207+102',
    '102+133+189+207 1 too-dressy 133+189+207+102',
    '102+149+202+207 1 too-dressy 149+202+207+102',
    '102+161+183+207 1 too-dressy 161+183+207+102',
    '102+140+202+207 1 too-dressy 140+202+207+102',
    '102+133+183+207 1 too-dressy 133+183+207+102',
    'more true',
  ],
  nearMisses: [
    '154+181+211 1 too-casual 154+181+211',
    '119+144+186+211 1 legs-too-warm 144+186+211+119',
    '173+194+215 1 too-casual 173+194+215',
    '119+137+202+214 1 too-casual 137+202+214+119',
    '143+204+215 1 too-casual 143+204+215',
    '161+189+214 1 too-casual 161+189+214',
    'more true',
  ],
  locked: [
    '102+131+202+207 1 too-dressy 131+202+207+102',
    '102+131+192+207 1 too-dressy 131+192+207+102',
    '102+131+183+207 1 too-dressy 131+183+207+102',
    '102+131+186+207 1 too-dressy 131+186+207+102',
    '102+131+189+207 1 too-dressy 131+189+207+102',
    '102+131+189+214 2 needs-water-resistance 131+189+214+102',
    'more true',
  ],
  small: [
    '115+105+108+112 1 too-cold 105+108+112+115',
    '115+105+110+112 1 too-cold 105+110+112+115',
    '103+110+113 2 needs-water-resistance 103+110+113',
    '103+108+113 2 needs-water-resistance 103+108+113',
    '117+107+108+112 2 needs-water-resistance 107+108+112+117',
    '103+108+112 2 needs-water-resistance 103+108+112',
    '103+110+112 2 needs-water-resistance 103+110+112',
    '117+107+110+112 2 needs-water-resistance 107+110+112+117',
    '107+110+113 4 too-cold/needs-water-resistance 107+110+113',
    '107+108+113 4 too-cold/needs-water-resistance 107+108+113',
    'more false',
  ],
  goesWith: '7482a9daaa25253f',
  sweep: '2eb50c8bed686d37',
};
