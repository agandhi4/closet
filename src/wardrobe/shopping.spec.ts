import { describe, expect, it } from 'vitest';
import type { ItemMatch, ItemStatus } from './plans';
import {
  fromCents,
  type ShoppingCandidate,
  type ShoppingItem,
  shoppingList,
  shoppingTotals,
  toCents,
} from './shopping';

function gap(
  item: ShoppingItem,
  status: ItemStatus,
  have: number,
  need: number,
): { item: ShoppingItem; match: ItemMatch } {
  return {
    item,
    match: {
      itemId: item.id,
      status,
      have,
      need,
      fulfilledBy: [],
      replaceSoon: [],
      takenBy: [],
      reason: status === 'owned' ? null : 'nothing-matches',
    },
  };
}

const candidate = (
  garmentId: number,
  price: string | null,
  matches = true,
): ShoppingCandidate => ({ garmentId, price, matches });

describe('shoppingList', () => {
  it('lists the gaps only, highest priority first, then missing before partly, then oldest', () => {
    const list = shoppingList(
      [
        gap({ id: 1, priority: 'medium', budget: null }, 'partly', 1, 3),
        gap({ id: 2, priority: 'high', budget: null }, 'owned', 1, 1),
        gap({ id: 3, priority: 'medium', budget: null }, 'missing', 0, 1),
        gap({ id: 4, priority: 'low', budget: null }, 'missing', 0, 2),
        gap({ id: 5, priority: 'high', budget: null }, 'partly', 2, 3),
        gap({ id: 6, priority: 'medium', budget: null }, 'missing', 0, 1),
      ],
      () => [],
    );
    expect(list.map((entry) => entry.item.id)).toEqual([5, 3, 6, 1, 4]);
    expect(list.map((entry) => entry.toBuy)).toEqual([1, 1, 1, 2, 2]);
  });

  it('orders candidates: matching first, within budget, then over, then unpriced, cheapest first', () => {
    const [entry] = shoppingList(
      [gap({ id: 1, priority: 'medium', budget: '50.00' }, 'missing', 0, 1)],
      () => [
        candidate(10, null),
        candidate(11, '80.00'),
        candidate(12, '49.90'),
        candidate(13, '20.00', false),
        candidate(14, '30.00'),
        candidate(15, '50.00'),
      ],
    );
    expect(
      entry.candidates.map(({ candidate: c, budget }) => [c.garmentId, budget]),
    ).toEqual([
      [14, 'within'],
      [12, 'within'],
      [15, 'within'],
      [11, 'over'],
      [10, 'unknown'],
      [13, 'within'],
    ]);
  });

  it('orders candidates without a budget cheapest first, unpriced last (#123)', () => {
    // Ids and input order chosen so a null price that compares equal to
    // everything (an intransitive sort) cannot come out right by accident.
    const [entry] = shoppingList(
      [gap({ id: 1, priority: 'medium', budget: null }, 'missing', 0, 1)],
      () => [
        candidate(10, '90.00'),
        candidate(11, null),
        candidate(12, '40.00'),
        candidate(13, null),
        candidate(14, '60.00'),
        candidate(9, '15.00', false),
      ],
    );
    expect(entry.candidates.map(({ candidate: c }) => c.garmentId)).toEqual([
      12, 14, 10, 11, 13, 9,
    ]);
  });

  it('knows no budget fit without a budget', () => {
    const [entry] = shoppingList(
      [gap({ id: 1, priority: 'medium', budget: null }, 'missing', 0, 1)],
      () => [candidate(10, '10.00')],
    );
    expect(entry.candidates[0].budget).toBe('unknown');
  });
});

describe('shoppingTotals', () => {
  it('adds budgets and the cheapest matching candidates over the copies to buy', () => {
    const list = shoppingList(
      [
        // Two more oxfords at $100: $200 of budget, candidates $79.90 each.
        gap({ id: 1, priority: 'medium', budget: '100.00' }, 'partly', 1, 3),
        // A merino at $50: its only candidate does not match.
        gap({ id: 2, priority: 'high', budget: '50.00' }, 'missing', 0, 1),
        // No budget, a $89.90 candidate.
        gap({ id: 3, priority: 'high', budget: null }, 'missing', 0, 1),
        // Owned: not shopping.
        gap({ id: 4, priority: 'high', budget: '999.00' }, 'owned', 1, 1),
      ],
      (id) =>
        ({
          1: [candidate(10, '79.90'), candidate(11, '95.00')],
          2: [candidate(12, '49.90', false)],
          3: [candidate(13, '89.90'), candidate(14, null)],
        })[id] ?? [],
    );
    expect(shoppingTotals(list)).toEqual({
      items: 3,
      pieces: 4,
      budgetCents: 25_000,
      unbudgeted: 1,
      cheapestCents: 2 * 7990 + 8990,
      withoutPricedMatch: 1,
    });
  });

  it('is all zeros for an empty list', () => {
    expect(shoppingTotals([])).toEqual({
      items: 0,
      pieces: 0,
      budgetCents: 0,
      unbudgeted: 0,
      cheapestCents: 0,
      withoutPricedMatch: 0,
    });
  });
});

describe('cents', () => {
  it('reads and writes the numeric column’s strings without a float’s error', () => {
    expect(toCents('49.90')).toBe(4990);
    expect(toCents('0.29')).toBe(29);
    expect(toCents('1299')).toBe(129_900);
    expect(fromCents(3 * toCents('0.10'))).toBe('0.30');
  });
});
