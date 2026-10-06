import { describe, expect, it } from 'vitest';
import { BUDGET_BANDS, STYLES } from '../../wardrobe/style';
import { budgetLabel, styleLabel } from './labels';

// tKey throws on a missing string: a value added to one of these sets
// without its label would be a 500 on the page that shows it.
describe('style labels', () => {
  it('has a string for every value of every set', () => {
    for (const style of STYLES) expect(styleLabel(style)).toMatch(/\S/);
    for (const band of BUDGET_BANDS) expect(budgetLabel(band)).toMatch(/\S/);
  });
});
