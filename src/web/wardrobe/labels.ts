import { gsmToOz } from '../../wardrobe/properties';
import { t, tKey } from '../i18n';

/**
 * The words for the property values (src/wardrobe/properties.ts owns the
 * values; src/i18n/en/lang.json's `property` group holds one string per
 * value, which labels.spec.ts checks for every set). Used by the form, the
 * garment page and the filters.
 */

export type LabelledProperty =
  | 'type'
  | 'warmth'
  | 'formality'
  | 'materials'
  | 'pattern'
  | 'fit'
  | 'sleeve'
  | 'length'
  | 'condition';

export function valueLabel(
  property: LabelledProperty,
  value: string | number,
): string {
  return tKey(`property.${property}.${value}`);
}

/** "6 oz · 203 gsm". */
export function fabricWeightLabel(gsm: number): string {
  return t('FABRIC_WEIGHT_VALUE', { oz: gsmToOz(gsm), gsm });
}
