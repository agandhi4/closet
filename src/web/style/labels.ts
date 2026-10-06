import type { BudgetBand, Style } from '../../wardrobe/style';
import { tKey } from '../i18n';

/**
 * The style profile's words (src/i18n/en/lang.json's `style` group;
 * labels.spec.ts checks every value has one).
 */

export function styleLabel(style: Style): string {
  return tKey(`style.style.${style}`);
}

export function budgetLabel(band: BudgetBand): string {
  return tKey(`style.budget.${band}`);
}
