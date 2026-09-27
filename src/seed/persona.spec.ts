import { describe, expect, it } from 'vitest';
import { BibleError } from './bible';
import { loadPersona, parsePersona, PERSONA_KEYS } from './persona';

/** The bibles are the seed's data: they parse, and a table the app would not store fails loudly. */
describe('persona bibles', () => {
  it.each(PERSONA_KEYS)('%s.md parses through the garment form', (key) => {
    expect(() => loadPersona(key)).not.toThrow();
  });

  it('reads Theo whole: 83 garments, 26 outfits, the week, events and laundry', () => {
    const demo = loadPersona('demo');
    expect(demo.account).toEqual({
      email: 'demo@closet.invalid',
      firstName: 'Theo',
      lastName: 'Marsh',
    });
    expect(demo.weather).toEqual({
      home: {
        name: 'Fort Greene, Brooklyn',
        location: { latitude: 40.69, longitude: -73.98 },
      },
      unit: 'fahrenheit',
    });
    expect(loadPersona('fresh').weather).toBeNull();
    expect(demo.garments).toHaveLength(83);
    expect(demo.garments.filter((g) => g.archivedOn)).toHaveLength(3);
    expect(demo.outfits).toHaveLength(26);
    expect(demo.week?.[3]).toEqual({
      draws: ['office'],
      occasion: 'work',
      workout: undefined,
    });
    // The morning workouts (#13): runs on Monday and Thursday, the gym on
    // Saturday; weekends and home days are all day.
    expect(demo.week?.map((day) => day.workout)).toEqual([
      undefined,
      'Run',
      undefined,
      undefined,
      'Run',
      undefined,
      'Gym',
    ]);
    expect(demo.week?.map((day) => day.occasion)).toEqual([
      'all-day',
      'all-day',
      'work',
      'work',
      'work',
      'all-day',
      'all-day',
    ]);
    expect(demo.events.find((e) => e.wears === 'Wedding')?.from).toBe(
      '2026-08-29',
    );

    const tee = demo.garments.find((g) => g.id === 'T01')!;
    expect(tee).toMatchObject({ role: 'top', away: null });
    expect(tee.fields).toMatchObject({
      quantity: 3,
      // The app's default for a top: the form's "the usual".
      washAfterWears: null,
      condition: 'good',
      conditionNote: null,
    });
    expect(tee.fields).toMatchObject({
      name: 'White tee',
      brand: 'Uniqlo',
      category: 'tops',
      type: 't-shirt',
      size: 'Medium',
      color: 'white',
      price: '24.90',
      sleeve: 'short',
    });
    // Paid, not list: the first amount in the cell.
    expect(demo.garments.find((g) => g.id === 'O02')!.fields.price).toBe(
      '400.00',
    );
    // "(same page)" rows carry the page's own link.
    expect(demo.garments.find((g) => g.id === 'T02')!.fields.sourceUrl).toBe(
      demo.garments.find((g) => g.id === 'T01')!.fields.sourceUrl,
    );
    const office = demo.outfits[0];
    expect(office).toMatchObject({ name: 'Office uniform', favourite: true });

    expect(demo.capsules.map((c) => c.fields.name)).toEqual([
      'Office',
      'Weekend',
      'Date night',
      'Travel',
    ]);
    expect(demo.capsules[3].fields.notes).toMatch(/Austin/);
    // An archived garment can be a member (it keeps its membership).
    expect(demo.capsules[1].garmentIds).toContain('Z03');
  });

  it('turns the Laundry, Condition and Away tables into garment form fields and away', () => {
    const demo = loadPersona('demo');
    const garment = (id: string) => demo.garments.find((g) => g.id === id)!;
    // Only where Theo differs from the app's defaults: sweaters 2, the raw
    // denim never (NEVER_WASH), the socks every wear; six socks.
    expect(garment('T20').fields.washAfterWears).toBe(2);
    expect(garment('B01').fields.washAfterWears).toBe(0);
    expect(garment('B02').fields.washAfterWears).toBeNull();
    expect(garment('A11').fields).toMatchObject({
      washAfterWears: 1,
      quantity: 6,
    });
    expect(garment('T21').fields).toMatchObject({
      condition: 'replace_soon',
      conditionNote: expect.stringMatching(/Pilling/),
    });
    expect(garment('B02').fields.condition).toBe('needs_repair');
    expect(garment('G04').away).toEqual({
      reason: 'lent',
      note: expect.stringMatching(/Dana/),
    });
    expect(garment('F07').away).toMatchObject({ reason: 'repair' });
    expect(demo.garments.filter((g) => g.away)).toHaveLength(2);
  });

  it('gives Dana and Riley no capsules', () => {
    expect(loadPersona('sparse').capsules).toEqual([]);
    expect(loadPersona('fresh').capsules).toEqual([]);
  });

  it("reads Theo's style profile and his plan through their forms (#34)", () => {
    const demo = loadPersona('demo');
    expect(demo.styleProfile).toEqual({
      styles: ['elevated-basics', 'smart-casual', 'outdoor-technical'],
      budget: 'mid',
      palette: ['green', 'blue', 'black', 'white', 'grey', 'beige', 'brown'],
      notes: expect.stringMatching(/One pattern at a time/),
    });
    // His week template (#16) is his week table: the day's Calendar
    // occasion, and the runs and the gym as workouts.
    expect(
      demo.weekTemplate?.map((slot) => `${slot.weekday} ${slot.occasion}`),
    ).toEqual([
      '0 all-day',
      '1 all-day',
      '1 workout',
      '2 work',
      '3 work',
      '4 workout',
      '4 work',
      '5 all-day',
      '6 all-day',
      '6 workout',
    ]);
    expect(loadPersona('fresh').weekTemplate).toBeNull();
    const [plan] = demo.plans;
    expect(demo.plans).toHaveLength(1);
    expect(plan).toMatchObject({
      fields: { name: 'NYC minimal', notes: null },
      active: true,
    });
    expect(plan.items).toHaveLength(19);
    // Its two gaps pair with the wishlist's merino and padded jacket (34b).
    expect(
      plan.items
        .filter((item) => item.candidates.length > 0)
        .map((item) => [item.fields.name, item.candidates]),
    ).toEqual([
      ['Grey merino crewneck', ['W01']],
      ['Brown padded shirt jacket', ['W02']],
    ]);
    expect(plan.items[1].fields).toEqual({
      name: 'White heavyweight tee',
      category: 'tops',
      type: 't-shirt',
      colors: ['white'],
      materials: null,
      warmthMin: 3,
      warmthMax: 5,
      formalityMin: null,
      formalityMax: null,
      quantity: 1,
      priority: 'medium',
      budget: '50.00',
      note: 'A tee that holds its shape on its own.',
    });
    expect(loadPersona('fresh')).toMatchObject({
      styleProfile: null,
      plans: [],
    });
    expect(loadPersona('sparse')).toMatchObject({
      styleProfile: null,
      plans: [],
    });
  });

  it("reads Theo's clashes, the generator's avoided pairs (#9); Dana and Riley have none", () => {
    expect(loadPersona('demo').avoid).toEqual([
      ['B06', 'O11'],
      ['T15', 'O01'],
    ]);
    expect(loadPersona('sparse').avoid).toEqual([]);
    expect(loadPersona('fresh').avoid).toEqual([]);
  });

  it("reads Theo's wishlist: three items, the merino replacing the pilling one", () => {
    const demo = loadPersona('demo');
    expect(
      demo.wishlist.map(({ id, replaces, fields }) => ({
        id,
        replaces,
        category: fields.category,
        price: fields.price,
        acquiredOn: fields.acquiredOn,
      })),
    ).toEqual([
      {
        id: 'W01',
        replaces: 'T21',
        category: 'tops',
        price: '49.90',
        acquiredOn: null,
      },
      {
        id: 'W02',
        replaces: null,
        category: 'outerwear',
        price: '89.90',
        acquiredOn: null,
      },
      {
        id: 'W03',
        replaces: null,
        category: 'footwear',
        price: '98.00',
        acquiredOn: null,
      },
    ]);
    // Owned garments only: a wishlist id is in no other table.
    expect(demo.garments.map((g) => g.id)).not.toContain('W01');
    expect(demo.garments.find((g) => g.id === 'T21')!.fields.condition).toBe(
      'replace_soon',
    );
    expect(loadPersona('fresh').wishlist).toEqual([]);
  });

  it('reads Dana: a custom category, four garments without a photo, a share with Theo', () => {
    const sparse = loadPersona('sparse');
    expect(sparse.garments.map((g) => g.fields.category)).toContain('scrubs');
    expect(sparse.garments.filter((g) => !g.photo)).toHaveLength(4);
    expect(sparse.sharesWith).toEqual([
      { persona: 'demo', permission: 'MANAGE' },
    ]);
    expect(sparse.outfits).toEqual([
      expect.objectContaining({
        name: null,
        occasions: [],
        garmentIds: ['S01', 'S04'],
      }),
    ]);
  });

  const bible = (
    garmentRow: string,
    header = '| id | Name in the app | Type | Colours | Sleeve |',
  ) =>
    `## Account\n\n| Field | Value |\n|---|---|\n| Email | x@closet.invalid |\n| First name | X |\n| Last name | Y |\n\n### Footwear\n\n${header}\n|---|---|---|---|---|\n${garmentRow}\n`;

  // A week whose Wednesday says `wednesday` in the given column.
  const week = (column: 'Calendar' | 'Workout', wednesday: string) =>
    `${bible('| F01 | Shoes | sneakers | white | — |')}\n## His week\n\n| Day | Draws from | ${column} |\n|---|---|---|\n${[
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
    ]
      .map((day) => `| ${day} | weekend | ${day === 'Wed' ? wednesday : '—'} |`)
      .join('\n')}\n`;

  it.each([
    [
      'a calendar occasion the app does not have',
      week('Calendar', 'office'),
      /Wed's calendar occasion office/,
    ],
    [
      'a workout that is not a saved outfit',
      week('Workout', 'Yoga'),
      /Wed's workout: no saved outfit is called "Yoga"/,
    ],
    [
      'a sleeve on shoes (the form would drop it)',
      bible('| F01 | Shoes | sneakers | white | long |'),
      /drops sleeve/,
    ],
    [
      'a weather location more precise than the app stores',
      bible('| F01 | Shoes | sneakers | white | — |').replace(
        '| Last name | Y |',
        '| Last name | Y |\n| Weather home | Here |\n| Weather location | 40.6892, -73.97 |\n| Temperature unit | celsius |',
      ),
      /Weather location is not a rounded/,
    ],
    [
      'a temperature unit the app does not have',
      bible('| F01 | Shoes | sneakers | white | — |').replace(
        '| Last name | Y |',
        '| Last name | Y |\n| Weather home | Here |\n| Weather location | 40.69, -73.97 |\n| Temperature unit | kelvin |',
      ),
      /Temperature unit is not one: kelvin/,
    ],
    [
      'a type from another category',
      bible('| F01 | Shoes | t-shirt | white | — |'),
      /drops type/,
    ],
    [
      'a colour outside the set',
      bible('| F01 | Shoes | sneakers | teal | — |'),
      /UNKNOWN_COLOR|teal/,
    ],
    [
      'an unknown column',
      bible(
        '| F01 | Shoes | sneakers | white | x |',
        '| id | Name in the app | Type | Colours | Heel |',
      ),
      /unknown garment column "Heel"/,
    ],
    [
      'a short row',
      bible('| F01 | Shoes | sneakers | white |'),
      /4 cells for 5 columns/,
    ],
    [
      'a capsule naming an unknown garment',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Capsules\n\n| Capsule | Garments | Notes |\n|---|---|---|\n| Shoes | F01, F99 | — |\n`,
      /capsule "Shoes": unknown garments: F99/,
    ],
    [
      'two capsules of one name, in any case',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Capsules\n\n| Capsule | Garments | Notes |\n|---|---|---|\n| Shoes | F01 | — |\n| SHOES | F01 | — |\n`,
      /two capsules are called "SHOES"/,
    ],
    [
      'a condition the app does not have',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Condition\n\n| Garment | Condition | Note |\n|---|---|---|\n| F01 | shabby | — |\n`,
      /not a garment form post/,
    ],
    [
      'away for a garment that is not there',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Away\n\n| Garment | Away | Note |\n|---|---|---|\n| F02 | lent | — |\n`,
      /Away: "F02" is not a garment/,
    ],
    [
      'an away reason the app does not have',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Away\n\n| Garment | Away | Note |\n|---|---|---|\n| F01 | stolen | — |\n`,
      /away: "stolen" is not lent or repair/,
    ],
    [
      'a capsule without a name',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Capsules\n\n| Capsule | Garments | Notes |\n|---|---|---|\n| — | F01 | — |\n`,
      /CAPSULE_NAME_REQUIRED|Give the capsule a name/,
    ],
    [
      'a wishlist item replacing a garment that is not owned',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Wishlist\n\n| id | Name in the app | Category / type | Colours | Replaces |\n|---|---|---|---|---|\n| W01 | New shoes | footwear / sneakers | white | F02 |\n`,
      /replaces "F02", not an owned garment/,
    ],
    [
      'an outfit wearing a wishlist item',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Wishlist\n\n| id | Name in the app | Category / type | Colours | Replaces |\n|---|---|---|---|---|\n| W01 | New shoes | footwear / sneakers | white | F01 |\n\n## Saved outfits\n\n| # | Name | Occasion | Bands | Garments |\n|---|---|---|---|---|\n| 1 | Look | weekend | any | F01, W01 |\n`,
      /unknown garments: W01/,
    ],
    [
      'a plan item the plan form would refuse',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Plan: Basics\n\n| Item | Category / type | Colours | Warmth |\n|---|---|---|---|\n| Tee | tops / jeans | white | — |\n`,
      /plan "Basics" item "Tee".*type/,
    ],
    [
      'a plan item candidate that is not on the wishlist',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Plan: Basics\n\n| Item | Category / type | Candidates |\n|---|---|---|\n| Shoes | footwear | F01 |\n`,
      /item "Shoes": candidate "F01" is not a wishlist id/,
    ],
    [
      'two active plans',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Plan: A (active)\n\n| Item | Category / type |\n|---|---|\n| Tee | tops |\n\n### Plan: B (active)\n\n| Item | Category / type |\n|---|---|\n| Tee | tops |\n`,
      /more than one plan is \(active\)/,
    ],
    [
      'a week whose day is dressed for an evening',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## His week\n\n| Day | Draws from | Calendar |\n|---|---|---|\n| Sun | weekend | all-day |\n| Mon | weekend | all-day |\n| Tue | weekend | all-day |\n| Wed | weekend | all-day |\n| Thu | weekend | all-day |\n| Fri | weekend | evening |\n| Sat | weekend | all-day |\n`,
      /week template: evening is not an outfit for the day/,
    ],
    [
      'a clash naming a garment that is not there',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Clashes\n\n| Garment | Never with | Why |\n|---|---|---|\n| F01 | F02 | — |\n`,
      /Clashes: "F01" and "F02" are not two owned garments/,
    ],
    [
      'a clash inside a saved outfit',
      `${bible('| F01 | Shoes | sneakers | white | — |\n| F02 | Boots | boots | brown | — |')}\n## Saved outfits\n\n| # | Name | Occasion | Bands | Garments |\n|---|---|---|---|---|\n| 1 | Look | weekend | any | F01, F02 |\n\n## Clashes\n\n| Garment | Never with | Why |\n|---|---|---|\n| F02 | F01 | — |\n`,
      /Clashes: F02 and F01 are together in a saved outfit/,
    ],
  ])('refuses %s', (_, markdown, message) => {
    expect(() => parsePersona('fresh', markdown)).toThrow(BibleError);
    expect(() => parsePersona('fresh', markdown)).toThrow(message);
  });
});
