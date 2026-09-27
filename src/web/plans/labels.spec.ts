import { describe, expect, it } from 'vitest';
import { PLAN_PRIORITIES } from '../../wardrobe/plans';
import { BUDGET_BANDS, RHYTHM_PERIODS, STYLES } from '../../wardrobe/style';
import {
  budgetLabel,
  itemFacts,
  itemTitle,
  periodLabel,
  priorityLabel,
  styleLabel,
} from './labels';
import type { PlanItemFields } from './validation';

// tKey throws on a missing string: a value added to one of these sets
// without its label would be a 500 on the page that shows it.
describe('plan and style labels', () => {
  it('has a string for every value of every set', () => {
    for (const style of STYLES) expect(styleLabel(style)).toMatch(/\S/);
    for (const band of BUDGET_BANDS) expect(budgetLabel(band)).toMatch(/\S/);
    for (const period of RHYTHM_PERIODS) {
      expect(periodLabel(period)).toMatch(/\S/);
    }
    for (const priority of PLAN_PRIORITIES) {
      expect(priorityLabel(priority)).toMatch(/\S/);
    }
  });

  const item: PlanItemFields = {
    name: null,
    category: 'tops',
    type: 't-shirt',
    colors: ['white'],
    materials: ['cotton'],
    warmthMin: 3,
    warmthMax: 5,
    formalityMin: 2,
    formalityMax: 2,
    quantity: 3,
    priority: 'medium',
    budget: null,
    note: null,
  };

  it('titles an item by its name, else its colours and type, else any of its category', () => {
    expect(itemTitle(item)).toBe('white T-shirt');
    expect(itemTitle({ ...item, name: 'Heavy tee' })).toBe('Heavy tee');
    expect(itemTitle({ ...item, type: null, colors: null })).toBe('Any Tops');
  });

  it('states its ranges and materials in words', () => {
    expect(itemFacts(item)).toEqual([
      'Medium to Very warm',
      'Casual',
      'Cotton',
    ]);
    // A named item also says what kind it is.
    expect(itemFacts({ ...item, name: 'Heavy tee' }).slice(0, 2)).toEqual([
      'T-shirt',
      'white',
    ]);
  });
});
