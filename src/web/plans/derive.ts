import { planItemsFromWardrobe } from '../../wardrobe/plans';
import { t } from '../i18n';
import type { ClosetGarment } from './queries';
import { ITEM_NOTE_MAX, type PlanItemFields } from './validation';

/** Source garments a derived item's note names before "and N more". */
const NOTE_SOURCES = 4;

/**
 * "Start from a wardrobe" (#34): a closet as plan items to store
 * (planItemsFromWardrobe groups it), each with a note naming the garments
 * it came from, so the owner sees what Theo's "white t-shirt ×4" is made
 * of: "From Theo's: White tee (Uniqlo), White heavyweight tee (Everlane)".
 * `ownerName` is the source wardrobe's first name; null for one's own.
 */
export function itemsFromCloset(
  closet: readonly ClosetGarment[],
  ownerName: string | null,
): PlanItemFields[] {
  return planItemsFromWardrobe(closet).map((item) => {
    const named = item.sources
      .slice(0, NOTE_SOURCES)
      .map(({ name, brand }) => (brand ? `${name ?? '?'} (${brand})` : name))
      .filter((label): label is string => Boolean(label));
    const more = item.sources.length - NOTE_SOURCES;
    const list =
      more > 0
        ? t('plans.SOURCES_MORE', { list: named.join(', '), count: more })
        : named.join(', ');
    const note =
      ownerName === null
        ? t('plans.FROM_MY_CLOSET_NOTE', { list })
        : t('plans.FROM_WARDROBE_NOTE', { name: ownerName, list });
    return {
      name: null,
      category: item.category,
      type: item.type,
      colors: item.colors.length > 0 ? item.colors : null,
      materials: null,
      warmthMin: null,
      warmthMax: null,
      formalityMin: null,
      formalityMax: null,
      quantity: item.quantity,
      priority: 'medium',
      budget: item.budget,
      note: list ? note.slice(0, ITEM_NOTE_MAX) : null,
    };
  });
}
