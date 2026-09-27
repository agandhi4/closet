import type { PlanPriority } from '../../wardrobe/plans';
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
