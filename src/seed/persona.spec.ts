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
    expect(demo.garments).toHaveLength(83);
    expect(demo.garments.filter((g) => g.archivedOn)).toHaveLength(3);
    expect(demo.outfits).toHaveLength(26);
    expect(demo.week?.[3]).toEqual(['office']);
    expect(demo.events.find((e) => e.wears === 'Wedding')?.from).toBe(
      '2026-08-29',
    );

    const tee = demo.garments.find((g) => g.id === 'T01')!;
    expect(tee).toMatchObject({ quantity: 3, role: 'top' });
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

  it.each([
    [
      'a sleeve on shoes (the form would drop it)',
      bible('| F01 | Shoes | sneakers | white | long |'),
      /drops sleeve/,
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
  ])('refuses %s', (_, markdown, message) => {
    expect(() => parsePersona('fresh', markdown)).toThrow(BibleError);
    expect(() => parsePersona('fresh', markdown)).toThrow(message);
  });
});
