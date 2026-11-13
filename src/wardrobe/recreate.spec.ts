import { describe, expect, it } from 'vitest';
import type { OutfitRule } from './outfit-rules';
import {
  builtInCategoriesOf,
  type GarmentColor,
  type InspirationPieceRole,
  type Pattern,
} from './properties';
import {
  type LookPiece,
  MATCHES_PER_PIECE,
  type RecreateGarment,
  type RecreateRequest,
  recreateLook,
} from './recreate';

/**
 * "Recreate this look" (#22b): the ranking (type, then colour, then
 * pattern, then availability and rest), the floor below which a piece is
 * missing, the re-pick when the closest set clashes (the colour rule, the
 * owner's never-rules, avoided pairs, one garment per piece), what the look
 * itself breaks excused, and determinism.
 */

let nextId = 1;

function garment(
  role: InspirationPieceRole,
  options: {
    type?: string | null;
    colors?: GarmentColor[];
    pattern?: Pattern | null;
    available?: boolean;
    idleDays?: number | null;
  } = {},
): RecreateGarment {
  return {
    id: nextId++,
    role,
    category: builtInCategoriesOf(role)[0],
    type: options.type ?? null,
    colors: options.colors ?? [],
    pattern: options.pattern ?? null,
    available: options.available ?? true,
    idleDays: options.idleDays === undefined ? 5 : options.idleDays,
  };
}

function piece(
  role: InspirationPieceRole,
  options: Partial<Omit<LookPiece, 'role'>> = {},
): LookPiece {
  return {
    role,
    type: options.type ?? null,
    colors: options.colors ?? [],
    pattern: options.pattern ?? null,
  };
}

function recreate(
  request: Partial<RecreateRequest<RecreateGarment>> & {
    pieces: LookPiece[];
    closet: RecreateGarment[];
  },
) {
  return recreateLook({ avoid: [], rules: [], ...request });
}

const ids = (matches: { garment: RecreateGarment }[]) =>
  matches.map((m) => m.garment.id);

describe('recreateLook', () => {
  it('ranks by type, then colour, then pattern, best first', () => {
    const whiteShirt = garment('top', { type: 'shirt', colors: ['white'] });
    const blackTee = garment('top', { type: 't-shirt', colors: ['black'] });
    const stripedTee = garment('top', {
      type: 't-shirt',
      colors: ['white'],
      pattern: 'stripes',
    });
    const solidTee = garment('top', {
      type: 't-shirt',
      colors: ['white'],
      pattern: 'solid',
    });
    const { pieces } = recreate({
      pieces: [
        piece('top', { type: 't-shirt', colors: ['white'], pattern: 'solid' }),
      ],
      closet: [whiteShirt, blackTee, stripedTee, solidTee],
    });
    expect(ids(pieces[0].matches)).toEqual([
      solidTee.id,
      stripedTee.id,
      blackTee.id,
    ]);
    expect(pieces[0].matches).toHaveLength(MATCHES_PER_PIECE);
    expect(pieces[0].matches[0].agrees).toEqual({
      type: true,
      color: 'exact',
      pattern: true,
    });
    expect(pieces[0].repicked).toBe(false);
  });

  it('ranks a close shade below the colour itself, and the main colour above the accent', () => {
    const black = garment('layer', { type: 'blazer', colors: ['black'] });
    const blue = garment('layer', { type: 'blazer', colors: ['blue'] });
    const white = garment('layer', { type: 'blazer', colors: ['white'] });
    const { pieces } = recreate({
      pieces: [piece('layer', { type: 'blazer', colors: ['blue', 'white'] })],
      closet: [white, black, blue],
    });
    // Blue is the main colour; black is close to it (navy), white the accent.
    expect(ids(pieces[0].matches)).toEqual([blue.id, black.id, white.id]);
    expect(pieces[0].matches.map((m) => m.agrees.color)).toEqual([
      'exact',
      'close',
      'close',
    ]);
  });

  it('calls a piece missing when nothing of its role shares its type or a colour', () => {
    const greenSweater = garment('top', { type: 'sweater', colors: ['green'] });
    const jeans = garment('bottom', { type: 'jeans', colors: ['blue'] });
    const { pieces } = recreate({
      pieces: [
        piece('top', { type: 't-shirt', colors: ['red'] }),
        piece('bottom', { type: 'jeans' }),
        piece('footwear', { type: 'sneakers' }),
      ],
      closet: [greenSweater, jeans],
    });
    expect(pieces[0].matches).toEqual([]);
    expect(ids(pieces[1].matches)).toEqual([jeans.id]);
    // No garment of the role at all.
    expect(pieces[2].matches).toEqual([]);
  });

  it('matches any garment of its role for a piece that names only its role', () => {
    const bag = garment('bag', { type: 'tote', colors: ['brown'] });
    const { pieces } = recreate({ pieces: [piece('bag')], closet: [bag] });
    expect(ids(pieces[0].matches)).toEqual([bag.id]);
  });

  it('breaks ties by availability, then the most rested, then the oldest', () => {
    const dirty = garment('bottom', { type: 'jeans', available: false });
    const worn = garment('bottom', { type: 'jeans', idleDays: 1 });
    const rested = garment('bottom', { type: 'jeans', idleDays: 40 });
    const never = garment('bottom', { type: 'jeans', idleDays: null });
    const neverToo = garment('bottom', { type: 'jeans', idleDays: null });
    const { pieces } = recreate({
      pieces: [piece('bottom', { type: 'jeans' })],
      closet: [dirty, worn, neverToo, rested, never],
    });
    expect(ids(pieces[0].matches)).toEqual([never.id, neverToo.id, rested.id]);
    const unavailableLast = recreate({
      pieces: [piece('bottom', { type: 'jeans' })],
      closet: [dirty, worn],
    });
    expect(ids(unavailableLast.pieces[0].matches)).toEqual([worn.id, dirty.id]);
  });

  it('re-picks the piece that mends a colour clash, the closest set kept elsewhere', () => {
    const redTee = garment('top', { type: 't-shirt', colors: ['red'] });
    const jeans = garment('bottom', { type: 'jeans', colors: ['blue'] });
    const greenSneakers = garment('footwear', {
      type: 'sneakers',
      colors: ['green'],
    });
    const whiteBoots = garment('footwear', {
      type: 'boots',
      colors: ['white'],
    });
    const purpleHat = garment('accessory', { type: 'hat', colors: ['purple'] });
    const { pieces, unfixed } = recreate({
      pieces: [
        piece('top', { type: 't-shirt', colors: ['red'] }),
        piece('bottom', { type: 'jeans', colors: ['blue'] }),
        piece('footwear', { type: 'sneakers', colors: ['white'] }),
        piece('accessory', { type: 'hat', colors: ['purple'] }),
      ],
      closet: [redTee, jeans, greenSneakers, whiteBoots, purpleHat],
    });
    // Red, green and purple are three accents: the sneakers give way.
    expect(pieces.map((p) => p.matches[0]?.garment.id)).toEqual([
      redTee.id,
      jeans.id,
      whiteBoots.id,
      purpleHat.id,
    ]);
    expect(pieces.map((p) => p.repicked)).toEqual([false, false, true, false]);
    // The closest stays among the alternates.
    expect(ids(pieces[2].matches)).toEqual([whiteBoots.id, greenSneakers.id]);
    expect(unfixed).toEqual([]);
  });

  it('keeps to the owner’s never-rules and avoided pairs', () => {
    const blackTee = garment('top', { type: 't-shirt', colors: ['black'] });
    const brownSneakers = garment('footwear', {
      type: 'sneakers',
      colors: ['brown'],
    });
    const whiteSneakers = garment('footwear', {
      type: 'sneakers',
      colors: ['white'],
    });
    const never: OutfitRule = {
      kind: 'never',
      a: { by: 'color', color: 'black' },
      b: { by: 'color', color: 'brown' },
    };
    const look = [
      piece('top', { type: 't-shirt', colors: ['black'] }),
      piece('footwear', { type: 'sneakers' }),
    ];
    const closet = [blackTee, brownSneakers, whiteSneakers];
    expect(
      recreate({ pieces: look, closet }).pieces[1].matches[0].garment.id,
    ).toBe(brownSneakers.id);
    const ruled = recreate({ pieces: look, closet, rules: [never] });
    expect(ruled.pieces[1].matches[0].garment.id).toBe(whiteSneakers.id);
    expect(ruled.pieces[1].repicked).toBe(true);
    const avoided = recreate({
      pieces: look,
      closet,
      avoid: [[blackTee.id, brownSneakers.id]],
    });
    expect(avoided.pieces[1].matches[0].garment.id).toBe(whiteSneakers.id);
    // An always-rule is not a never-rule: nothing changes.
    const always = recreate({
      pieces: look,
      closet,
      rules: [{ ...never, kind: 'always' }],
    });
    expect(always.pieces[1].matches[0].garment.id).toBe(brownSneakers.id);
  });

  it('excuses what the look itself breaks', () => {
    const blackTee = garment('top', { type: 't-shirt', colors: ['black'] });
    const brownSneakers = garment('footwear', {
      type: 'sneakers',
      colors: ['brown'],
    });
    const whiteSneakers = garment('footwear', {
      type: 'sneakers',
      colors: ['white'],
    });
    const { pieces } = recreate({
      pieces: [
        piece('top', { type: 't-shirt', colors: ['black'] }),
        piece('footwear', { type: 'sneakers', colors: ['brown'] }),
      ],
      closet: [blackTee, whiteSneakers, brownSneakers],
      rules: [
        {
          kind: 'never',
          a: { by: 'color', color: 'black' },
          b: { by: 'color', color: 'brown' },
        },
      ],
    });
    expect(pieces[1].matches[0].garment.id).toBe(brownSneakers.id);
    expect(pieces[1].repicked).toBe(false);

    // Three accents in the look: the closet's three are its point.
    const loud = recreate({
      pieces: [
        piece('top', { colors: ['red'] }),
        piece('footwear', { colors: ['green'] }),
        piece('accessory', { colors: ['yellow'] }),
      ],
      closet: [
        garment('top', { colors: ['red'] }),
        garment('footwear', { colors: ['green'] }),
        garment('accessory', { colors: ['yellow'] }),
      ],
    });
    expect(loud.pieces.every((p) => p.matches.length === 1)).toBe(true);
    expect(loud.unfixed).toEqual([]);
  });

  it('names the pieces it could not mend, keeping the closest', () => {
    const tee = garment('top', { type: 't-shirt', colors: ['white'] });
    const jeans = garment('bottom', { type: 'jeans', colors: ['blue'] });
    const { pieces, unfixed } = recreate({
      pieces: [
        piece('top', { type: 't-shirt' }),
        piece('bottom', { type: 'jeans' }),
      ],
      closet: [tee, jeans],
      avoid: [[tee.id, jeans.id]],
    });
    expect(pieces.map((p) => p.matches[0].garment.id)).toEqual([
      tee.id,
      jeans.id,
    ]);
    expect(unfixed).toEqual([0, 1]);
  });

  it('never fills two pieces with one garment', () => {
    const tee = garment('top', { type: 't-shirt', colors: ['white'] });
    const shirt = garment('top', { type: 'shirt', colors: ['white'] });
    const two = [
      piece('top', { type: 't-shirt', colors: ['white'] }),
      piece('top', { type: 'shirt', colors: ['white'] }),
    ];
    const both = recreate({ pieces: two, closet: [tee, shirt] });
    expect(both.pieces.map((p) => p.matches[0].garment.id)).toEqual([
      tee.id,
      shirt.id,
    ]);
    // One white top for two white pieces: the second goes missing.
    const one = recreate({ pieces: two, closet: [tee] });
    expect(one.pieces[0].matches[0].garment.id).toBe(tee.id);
    expect(one.pieces[1].matches).toEqual([]);
    expect(one.unfixed).toEqual([]);
  });

  it('fills as many pieces as the closet allows, a flexible piece yielding another’s only garment', () => {
    const belt = garment('accessory', { type: 'belt', colors: ['brown'] });
    const hat = garment('accessory', { type: 'hat', colors: ['black'] });
    const scarf = garment('accessory', { type: 'scarf', colors: ['grey'] });
    const { pieces, unfixed } = recreate({
      pieces: [
        piece('accessory'),
        piece('accessory', { type: 'belt' }),
        piece('accessory', { type: 'hat' }),
        piece('accessory', { type: 'hat' }),
      ],
      closet: [belt, hat, scarf],
    });
    expect(pieces.map((p) => p.matches[0]?.garment.id)).toEqual([
      scarf.id,
      belt.id,
      hat.id,
      undefined,
    ]);
    expect(unfixed).toEqual([]);
  });

  it('gives the earlier piece its closest when two ways fill as many', () => {
    const white = garment('top', { type: 't-shirt', colors: ['white'] });
    const grey = garment('top', { type: 't-shirt', colors: ['grey'] });
    const { pieces } = recreate({
      pieces: [
        piece('top', { type: 't-shirt', colors: ['white'] }),
        piece('top', { type: 't-shirt', colors: ['white'] }),
      ],
      closet: [grey, white],
    });
    expect(pieces.map((p) => p.matches[0].garment.id)).toEqual([
      white.id,
      grey.id,
    ]);
    expect(pieces.map((p) => p.repicked)).toEqual([false, true]);
  });

  it('still mends a clash when a piece goes missing for want of a garment of its own', () => {
    const tee = garment('top', { type: 't-shirt', colors: ['white'] });
    const jeans = garment('bottom', { type: 'jeans', colors: ['blue'] });
    const otherJeans = garment('bottom', { type: 'jeans', colors: ['black'] });
    const { pieces, unfixed } = recreate({
      pieces: [
        piece('top', { type: 't-shirt' }),
        piece('top', { type: 't-shirt' }),
        piece('bottom', { type: 'jeans' }),
      ],
      closet: [tee, jeans, otherJeans],
      avoid: [[tee.id, jeans.id]],
    });
    expect(pieces.map((p) => p.matches[0]?.garment.id)).toEqual([
      tee.id,
      undefined,
      otherJeans.id,
    ]);
    expect(pieces[2].repicked).toBe(true);
    expect(unfixed).toEqual([]);
  });

  it('answers the same for the same closet, in whatever order it comes', () => {
    const closet = [
      garment('top', { type: 't-shirt', colors: ['white'], idleDays: null }),
      garment('top', { type: 't-shirt', colors: ['white'], idleDays: null }),
      garment('top', { type: 'shirt', colors: ['blue'] }),
      garment('bottom', { type: 'jeans', colors: ['blue'] }),
      garment('bottom', { type: 'chinos', colors: ['beige'] }),
      garment('footwear', { type: 'sneakers', colors: ['white'] }),
    ];
    const look = [
      piece('top', { type: 't-shirt', colors: ['white'] }),
      piece('bottom', { colors: ['blue'] }),
      piece('footwear', { type: 'sneakers' }),
    ];
    const first = recreate({ pieces: look, closet });
    expect(recreate({ pieces: look, closet })).toEqual(first);
    expect(recreate({ pieces: look, closet: [...closet].reverse() })).toEqual(
      first,
    );
  });

  it('answers an empty closet and a look without pieces', () => {
    expect(
      recreate({ pieces: [piece('top', { type: 'shirt' })], closet: [] }),
    ).toEqual({ pieces: [{ matches: [], repicked: false }], unfixed: [] });
    expect(recreate({ pieces: [], closet: [garment('top')] })).toEqual({
      pieces: [],
      unfixed: [],
    });
  });
});
