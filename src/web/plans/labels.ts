import type { PlanPriority, TargetDifference } from '../../wardrobe/plans';
import type { BudgetBand, RhythmPeriod, Style } from '../../wardrobe/style';
import { t, tKey } from '../i18n';
import { categoryLabel } from '../wardrobe/garment';
import { valueLabel } from '../wardrobe/labels';
import type { PlanItemFields } from './validation';

/**
 * The words for plan items and the style profile (src/i18n/en/lang.json's
 * `plans` and `style` groups; labels.spec.ts checks every value has one).
 * Used by the gap view, the item and profile forms, and the plans list.
 */

export function styleLabel(style: Style): string {
  return tKey(`style.style.${style}`);
}

export function budgetLabel(band: BudgetBand): string {
  return tKey(`style.budget.${band}`);
}

export function periodLabel(period: RhythmPeriod): string {
  return tKey(`style.per.${period}`);
}

export function priorityLabel(priority: PlanPriority): string {
  return tKey(`plans.priority.${priority}`);
}

/**
 * What an item is, in a few words: its own name, else its colours and
 * type (or category): "white, blue T-shirt", "Any tops" when it names
 * neither.
 */
export function itemTitle(
  item: Pick<PlanItemFields, 'name' | 'category' | 'type' | 'colors'>,
): string {
  if (item.name) return item.name;
  const kind = item.type
    ? valueLabel('type', item.type)
    : categoryLabel(item.category);
  const colors = item.colors ?? [];
  return colors.length > 0
    ? `${colors.join(', ')} ${kind}`
    : t('plans.ANY_OF', { kind });
}

/** A range on a garment scale: "Light", or "Light to Warm". */
function rangeLabel(
  property: 'warmth' | 'formality',
  min: number,
  max: number,
): string {
  return min === max
    ? valueLabel(property, min)
    : t('plans.RANGE', {
        from: valueLabel(property, min),
        to: valueLabel(property, max),
      });
}

/**
 * The constraints beyond the title, each a short phrase: the category
 * under a named item, the type's category, warmth and formality ranges,
 * materials.
 */
export function itemFacts(item: PlanItemFields): string[] {
  const facts: string[] = [];
  if (item.name) {
    facts.push(
      item.type ? valueLabel('type', item.type) : categoryLabel(item.category),
    );
    if (item.colors) facts.push(item.colors.join(', '));
  }
  if (item.warmthMin !== null && item.warmthMax !== null) {
    facts.push(rangeLabel('warmth', item.warmthMin, item.warmthMax));
  }
  if (item.formalityMin !== null && item.formalityMax !== null) {
    facts.push(rangeLabel('formality', item.formalityMin, item.formalityMax));
  }
  if (item.materials) {
    facts.push(
      item.materials.map((m) => valueLabel('materials', m)).join(', '),
    );
  }
  return facts;
}

/** A garment's value as a difference names it: its label, or "none". */
function haveLabel(
  property: 'type' | 'warmth' | 'formality',
  value: string | number | null,
): string {
  return value === null ? t('shopping.NONE') : valueLabel(property, value);
}

/** A set as a difference names it: its values, or "none" when empty. */
function setLabel(values: readonly string[], label: (v: string) => string) {
  return values.map(label).join(', ') || t('shopping.NONE');
}

const VERSUS_KEYS = {
  warmth: 'shopping.VERSUS_WARMTH',
  formality: 'shopping.VERSUS_FORMALITY',
} as const;

/** One way a garment falls outside a plan item, in words: "blue vs black". */
export function differenceText(difference: TargetDifference): string {
  switch (difference.property) {
    case 'category':
      return t('shopping.VERSUS', {
        have: categoryLabel(difference.have),
        want: categoryLabel(difference.want),
      });
    case 'type':
      return t('shopping.VERSUS', {
        have: haveLabel('type', difference.have),
        want: valueLabel('type', difference.want),
      });
    case 'colors':
      return t('shopping.VERSUS', {
        have: setLabel(difference.have, (color) => color),
        want: setLabel(difference.want, (color) => color),
      });
    case 'materials': {
      const material = (value: string) => valueLabel('materials', value);
      return t('shopping.VERSUS', {
        have: setLabel(difference.have, material),
        want: setLabel(difference.want, material),
      });
    }
    case 'warmth':
    case 'formality': {
      const { property, have, want } = difference;
      return t(VERSUS_KEYS[property], {
        have: haveLabel(property, have),
        want: rangeLabel(property, want.min, want.max),
      });
    }
  }
}

/** Every difference, joined: "blue vs black; Jacket vs Coat". */
export function differencesText(
  differences: readonly TargetDifference[],
): string {
  return differences.map(differenceText).join('; ');
}
