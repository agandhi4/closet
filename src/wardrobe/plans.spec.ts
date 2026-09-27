import { describe, expect, it } from 'vitest';
import { QUANTITY_MAX } from './availability';
import {
  type ClosetPiece,
  comparePlans,
  fitTargetTo,
  matchesTarget,
  matchPlan,
  planItemsFromWardrobe,
  type PlanTarget,
  planTally,
  type SourceGarment,
  targetDifferences,
} from './plans';

let nextId = 1;

/** A plan item: tops of any type, colour and material, one wanted. */
function target(fields: Partial<PlanTarget> = {}): PlanTarget {
  return {
    id: nextId++,
    category: 'tops',
    type: null,
    colors: [],
    materials: [],
    warmth: null,
    formality: null,
    quantity: 1,
    priority: 'medium',
    ...fields,
  };
}

/** A closet garment: a plain white cotton tee in good shape. */
function piece(fields: Partial<ClosetPiece> = {}): ClosetPiece {
  return {
    id: nextId++,
    category: 'tops',
    type: 't-shirt',
    colors: ['white'],
    materials: ['cotton'],
    warmth: 2,
    formality: 2,
    quantity: 1,
    condition: 'good',
    ...fields,
  };
}

describe('matchesTarget', () => {
  it('needs the category, and the type when the item names one', () => {
    expect(matchesTarget(target(), piece())).toBe(true);
    expect(matchesTarget(target({ category: 'bottoms' }), piece())).toBe(false);
    expect(matchesTarget(target({ type: 't-shirt' }), piece())).toBe(true);
    expect(matchesTarget(target({ type: 'shirt' }), piece())).toBe(false);
    expect(
      matchesTarget(target({ type: 'shirt' }), piece({ type: null })),
    ).toBe(false);
  });

  it('needs every colour and material the item names, and allows more', () => {
    const breton = piece({ colors: ['white', 'blue'] });
    expect(matchesTarget(target({ colors: ['blue'] }), breton)).toBe(true);
    expect(matchesTarget(target({ colors: ['white', 'blue'] }), breton)).toBe(
      true,
    );
    expect(matchesTarget(target({ colors: ['black'] }), breton)).toBe(false);
    expect(matchesTarget(target({ materials: ['cotton'] }), piece())).toBe(
      true,
    );
    expect(matchesTarget(target({ materials: ['merino'] }), piece())).toBe(
      false,
    );
  });

  it('needs warmth and formality inside the item’s ranges; unset on the garment is outside', () => {
    const heavy = target({ warmth: { min: 3, max: 5 } });
    expect(matchesTarget(heavy, piece({ warmth: 3 }))).toBe(true);
    expect(matchesTarget(heavy, piece({ warmth: 2 }))).toBe(false);
    expect(matchesTarget(heavy, piece({ warmth: null }))).toBe(false);
    const smart = target({ formality: { min: 3, max: 4 } });
    expect(matchesTarget(smart, piece({ formality: 4 }))).toBe(true);
    expect(matchesTarget(smart, piece({ formality: 1 }))).toBe(false);
    expect(matchesTarget(target(), piece({ warmth: null }))).toBe(true);
  });
});

describe('matchPlan', () => {
  it('owns an item when its copies reach the quantity, partly below it, and misses it with none', () => {
    const tees = target({ quantity: 3 });
    const socks = target({ category: 'accessories', quantity: 6 });
    const coat = target({ category: 'outerwear' });
    const [a, b, c] = matchPlan(
      [tees, socks, coat],
      [
        piece({ quantity: 3 }),
        piece({ category: 'accessories', type: null, quantity: 4 }),
      ],
    );
    expect(a).toMatchObject({
      status: 'owned',
      have: 3,
      need: 3,
      reason: null,
    });
    expect(b).toMatchObject({
      status: 'partly',
      have: 4,
      need: 6,
      reason: 'too-few-copies',
    });
    expect(c).toMatchObject({
      status: 'missing',
      have: 0,
      reason: 'nothing-matches',
      fulfilledBy: [],
    });
  });

  it('answers the items in the order they were given', () => {
    const items = [target({ category: 'bags' }), target(), target()];
    expect(matchPlan(items, [piece()]).map((m) => m.itemId)).toEqual(
      items.map((item) => item.id),
    );
  });

  it('counts a replace_soon garment as a gap to refill, and says so', () => {
    const merino = target({ type: 'sweater', colors: ['grey'] });
    const pilling = piece({
      type: 'sweater',
      colors: ['grey'],
      condition: 'replace_soon',
    });
    const [match] = matchPlan([merino], [pilling]);
    expect(match).toMatchObject({
      status: 'missing',
      have: 0,
      reason: 'replace-soon',
      replaceSoon: [pilling.id],
      fulfilledBy: [],
    });
    // Beside a good copy it is the rest of the gap.
    const good = piece({ type: 'sweater', colors: ['grey'] });
    const [two] = matchPlan([{ ...merino, quantity: 2 }], [pilling, good]);
    expect(two).toMatchObject({
      status: 'partly',
      have: 1,
      reason: 'replace-soon',
      replaceSoon: [pilling.id],
    });
  });

  it('counts a needs_repair garment as owned, flagged', () => {
    const jeans = target({ category: 'bottoms' });
    const torn = piece({ category: 'bottoms', condition: 'needs_repair' });
    const [match] = matchPlan([jeans], [torn]);
    expect(match).toMatchObject({
      status: 'owned',
      fulfilledBy: [{ garmentId: torn.id, copies: 1, needsRepair: true }],
    });
  });

  it('lets one garment fulfil one item, and names the item that took it', () => {
    const first = target();
    const second = target();
    const tee = piece();
    const [a, b] = matchPlan([first, second], [tee]);
    expect(a.status).toBe('owned');
    expect(b).toMatchObject({
      status: 'missing',
      reason: 'taken-by-other-items',
      takenBy: [{ garmentId: tee.id, itemId: first.id }],
    });
  });

  it('never splits a garment’s copies between items', () => {
    const [a, b] = matchPlan(
      [target({ quantity: 1 }), target({ quantity: 1 })],
      [piece({ quantity: 3 })],
    );
    expect(a).toMatchObject({ status: 'owned', have: 3 });
    expect(b.status).toBe('missing');
  });

  it('lets the item with fewer candidates choose first, so a specific item is not starved by a general one', () => {
    // Listed first and high priority, "any tee" would take the only heavy
    // one if items chose in order.
    const anyTee = target({ type: 't-shirt', priority: 'high' });
    const heavyTee = target({
      type: 't-shirt',
      warmth: { min: 3, max: 5 },
      priority: 'low',
    });
    const light = piece({ warmth: 2 });
    const heavy = piece({ warmth: 3 });
    const [a, b] = matchPlan([anyTee, heavyTee], [heavy, light]);
    expect(a.fulfilledBy.map((f) => f.garmentId)).toEqual([light.id]);
    expect(b.fulfilledBy.map((f) => f.garmentId)).toEqual([heavy.id]);
  });

  it('breaks a tie in candidates by priority, then by the item’s id', () => {
    const low = target({ priority: 'low' });
    const high = target({ priority: 'high' });
    const tee = piece();
    const [a, b] = matchPlan([low, high], [tee]);
    expect(b.status).toBe('owned');
    expect(a.status).toBe('missing');
    const [c, d] = matchPlan([target(), target()], [tee]);
    expect(c.status).toBe('owned');
    expect(d.status).toBe('missing');
  });

  it('prefers the closest garment: fewest extra colours and materials, then good condition, then the oldest', () => {
    const navy = target({ colors: ['blue'], materials: ['cotton'] });
    const stripe = piece({ colors: ['white', 'blue'] });
    const plain = piece({ colors: ['blue'] });
    const blend = piece({ colors: ['blue'], materials: ['cotton', 'linen'] });
    expect(
      matchPlan([navy], [stripe, blend, plain])[0].fulfilledBy[0].garmentId,
    ).toBe(plain.id);
    const torn = piece({ colors: ['blue'], condition: 'needs_repair' });
    const fine = piece({ colors: ['blue'] });
    expect(matchPlan([navy], [torn, fine])[0].fulfilledBy[0].garmentId).toBe(
      fine.id,
    );
    const older = piece({ colors: ['blue'] });
    const newer = piece({ colors: ['blue'] });
    expect(matchPlan([navy], [newer, older])[0].fulfilledBy[0].garmentId).toBe(
      older.id,
    );
  });

  it('takes garments until the quantity is reached, and no more', () => {
    const [match] = matchPlan(
      [target({ quantity: 2 })],
      [piece(), piece(), piece()],
    );
    expect(match.fulfilledBy).toHaveLength(2);
    expect(match.have).toBe(2);
  });

  it('tallies a plan', () => {
    const matches = matchPlan(
      [target(), target({ quantity: 2 }), target({ category: 'bags' })],
      [piece(), piece()],
    );
    expect(planTally(matches)).toEqual({ owned: 1, partly: 1, missing: 1 });
  });
});

describe('targetDifferences', () => {
  it('names nothing for a garment the item takes', () => {
    expect(targetDifferences(target({ colors: ['white'] }), piece())).toEqual(
      [],
    );
  });

  it('names each constraint the garment misses, with what it has and what the item asks', () => {
    const item = target({
      type: 'sweater',
      colors: ['black'],
      materials: ['merino'],
      warmth: { min: 3, max: 4 },
      formality: { min: 2, max: 3 },
    });
    const navyCotton = piece({
      type: 'sweater',
      colors: ['blue'],
      warmth: 2,
      formality: null,
    });
    expect(targetDifferences(item, navyCotton)).toEqual([
      { property: 'colors', have: ['blue'], want: ['black'] },
      { property: 'materials', have: ['cotton'], want: ['merino'] },
      { property: 'warmth', have: 2, want: { min: 3, max: 4 } },
      { property: 'formality', have: null, want: { min: 2, max: 3 } },
    ]);
    expect(
      targetDifferences(target({ type: 'shirt' }), piece({ type: null })),
    ).toEqual([{ property: 'type', have: null, want: 'shirt' }]);
  });

  it('names only the category when the garment is another kind of thing', () => {
    expect(
      targetDifferences(
        target({ category: 'outerwear', colors: ['brown'] }),
        piece(),
      ),
    ).toEqual([{ property: 'category', have: 'tops', want: 'outerwear' }]);
  });

  it('is what matchesTarget answers', () => {
    const item = target({ colors: ['black'] });
    expect(matchesTarget(item, piece())).toBe(false);
    expect(matchesTarget(item, piece({ colors: ['black'] }))).toBe(true);
  });
});

describe('fitTargetTo', () => {
  it('changes only what differs, just enough for the garment to match', () => {
    const item = target({
      type: 'sweater',
      colors: ['black'],
      materials: ['merino'],
      warmth: { min: 3, max: 4 },
      formality: { min: 2, max: 3 },
    });
    const navy = piece({
      type: 'sweater',
      colors: ['blue', 'white'],
      materials: ['merino', 'cotton'],
      warmth: 5,
      formality: 2,
    });
    const fitted = fitTargetTo(item, navy);
    expect(fitted).toEqual({
      category: 'tops',
      type: 'sweater',
      colors: ['blue', 'white'],
      materials: ['merino'],
      warmth: { min: 3, max: 5 },
      formality: { min: 2, max: 3 },
    });
    expect(targetDifferences(fitted, navy)).toEqual([]);
  });

  it('opens a range the garment has no value for, and takes another kind whole', () => {
    expect(
      fitTargetTo(
        target({ warmth: { min: 3, max: 3 } }),
        piece({ warmth: null }),
      ).warmth,
    ).toBeNull();
    const jacket = piece({
      category: 'outerwear',
      type: 'jacket',
      colors: ['brown'],
      warmth: 3,
    });
    const fitted = fitTargetTo(
      target({
        type: 't-shirt',
        colors: ['white'],
        warmth: { min: 1, max: 2 },
      }),
      jacket,
    );
    expect(fitted).toMatchObject({
      category: 'outerwear',
      type: 'jacket',
      colors: ['brown'],
      warmth: { min: 1, max: 3 },
    });
    expect(matchesTarget(fitted, jacket)).toBe(true);
  });
});

describe('comparePlans', () => {
  const item = (fields: Partial<PlanTarget>) => target(fields);

  it('pairs items of the same kind and names what each plan adds or drops', () => {
    const tee = item({ type: 't-shirt', colors: ['white'], quantity: 3 });
    const oxford = item({ type: 'shirt', quantity: 2 });
    const parka = item({ category: 'outerwear', type: 'parka' });
    const tee2 = item({ type: 't-shirt', colors: ['white'], quantity: 4 });
    const oxford2 = item({ type: 'shirt', quantity: 2 });
    const blazer = item({ category: 'outerwear', type: 'blazer' });
    const result = comparePlans([tee, oxford, parka], [blazer, oxford2, tee2]);
    expect(result.both).toEqual([
      { a: tee, b: tee2, changes: ['quantity'] },
      { a: oxford, b: oxford2, changes: [] },
    ]);
    expect(result.dropped).toEqual([parka]);
    expect(result.added).toEqual([blazer]);
  });

  it('reads colours as a set, and pairs two of a kind in order', () => {
    const a1 = item({ colors: ['white', 'blue'] });
    const a2 = item({ colors: ['blue', 'white'], priority: 'high' });
    const b1 = item({ colors: ['blue', 'white'], warmth: { min: 2, max: 3 } });
    const result = comparePlans([a1, a2], [b1]);
    expect(result.both).toEqual([{ a: a1, b: b1, changes: ['details'] }]);
    expect(result.dropped).toEqual([a2]);
    expect(result.added).toEqual([]);
  });

  it('notes a changed priority and materials', () => {
    const a = item({ materials: ['merino'], priority: 'high' });
    const b = item({ materials: ['wool'] });
    expect(comparePlans([a], [b]).both[0].changes).toEqual([
      'priority',
      'details',
    ]);
  });
});

describe('planItemsFromWardrobe', () => {
  const source = (fields: Partial<SourceGarment>): SourceGarment => ({
    id: nextId++,
    name: null,
    brand: null,
    category: 'tops',
    type: 't-shirt',
    colors: ['white'],
    quantity: 1,
    price: null,
    ...fields,
  });

  it('groups by category, type and colour set, adding up the copies', () => {
    const items = planItemsFromWardrobe([
      source({ name: 'White tee', brand: 'Uniqlo', quantity: 3 }),
      source({ name: 'White heavyweight tee', brand: 'Everlane' }),
      source({ name: 'Breton', colors: ['blue', 'white'] }),
      source({ name: 'Jeans', category: 'bottoms', type: 'jeans' }),
    ]);
    // Within a type, colour sets in the palette's order (blue before white).
    expect(
      items.map((i) => [i.category, i.type, i.colors, i.quantity]),
    ).toEqual([
      ['tops', 't-shirt', ['blue', 'white'], 1],
      ['tops', 't-shirt', ['white'], 4],
      ['bottoms', 'jeans', ['white'], 1],
    ]);
    expect(items[1].sources).toEqual([
      { name: 'White tee', brand: 'Uniqlo' },
      { name: 'White heavyweight tee', brand: 'Everlane' },
    ]);
  });

  it('reads colours as a set, in the palette’s order', () => {
    const items = planItemsFromWardrobe([
      source({ colors: ['white', 'blue'] }),
      source({ colors: ['blue', 'white'] }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].colors).toEqual(['blue', 'white']);
  });

  it('orders items as the wardrobe lists categories and types, untyped last', () => {
    const items = planItemsFromWardrobe([
      source({ category: 'footwear', type: 'boots' }),
      source({ type: null }),
      source({ type: 'shirt' }),
      source({ type: 't-shirt' }),
      source({ category: 'gym kit', type: null }),
    ]);
    expect(items.map((i) => [i.category, i.type])).toEqual([
      ['tops', 't-shirt'],
      ['tops', 'shirt'],
      ['tops', null],
      ['footwear', 'boots'],
      ['gym kit', null],
    ]);
  });

  it('budgets the dearest piece of a group, and caps the copies at the form’s', () => {
    const [item] = planItemsFromWardrobe([
      source({ price: '24.90', quantity: 20 }),
      source({ price: '48.00', quantity: 20 }),
      source({ price: null }),
    ]);
    expect(item.budget).toBe('48.00');
    expect(item.quantity).toBe(QUANTITY_MAX);
    const [none] = planItemsFromWardrobe([source({})]);
    expect(none.budget).toBeNull();
  });
});
