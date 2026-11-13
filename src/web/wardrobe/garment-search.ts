import type { CareWash } from '../../wardrobe/care';
import {
  findType,
  type Formality,
  type GarmentColor,
  type Material,
  typesOf,
  type Warmth,
} from '../../wardrobe/properties';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { normalizeCategory, normalizeSize } from './garment';
import type { GridFilters } from './queries';

/**
 * A garment search as a caller that names its filters asks it: MCP's
 * search_garments and the API's GET /garments (#192a), both readers of
 * searchGarments (garment-access.ts). The grid's page reads its own URL
 * state (gridSearch, grid-routes.tsx), which drops what does not apply;
 * these callers named the filter, so a type without its category is a 400.
 */
export interface GarmentSearchInput {
  keyword?: string;
  category?: string;
  type?: string;
  color?: GarmentColor;
  size?: string;
  warmth?: Warmth;
  formality?: Formality;
  material?: Material;
  wash?: CareWash;
  capsuleId?: number;
  includeArchived: boolean;
  needsWash: boolean;
  needsAttention: boolean;
  needsTagging: boolean;
}

/** A type only with its own category, as the grid (gridSearch) allows it. */
export function checkedType(category: string, type: string): string {
  if (!category) {
    throw new HttpError(400, t('garmentSearch.TYPE_NEEDS_CATEGORY'));
  }
  const found = findType(category, type);
  if (!found) {
    const types = typesOf(category).map(({ value }) => value);
    throw new HttpError(
      400,
      types.length > 0
        ? t('garmentSearch.NOT_A_TYPE_OF', {
            type,
            category,
            types: types.join(', '),
          })
        : t('garmentSearch.NO_TYPES', { category }),
    );
  }
  return found.value;
}

/**
 * The search as the grid's filters (gridSearch's rules: a category
 * normalized, a type only with its category, a size normalized); a type
 * without one, or not of it, is a 400 (checkedType) before the wardrobe is
 * read.
 */
export function searchFilters(input: GarmentSearchInput): GridFilters {
  const category = input.category ? normalizeCategory(input.category) : '';
  return {
    keyword: input.keyword?.trim() || undefined,
    category: category || undefined,
    type: input.type ? checkedType(category, input.type) : undefined,
    color: input.color,
    size: normalizeSize(input.size ?? '') ?? undefined,
    warmth: input.warmth,
    formality: input.formality,
    material: input.material,
    wash: input.wash,
    capsule: input.capsuleId,
    scope: input.includeArchived ? 'owned' : 'closet',
    needsWash: input.needsWash,
    attention: input.needsAttention,
    needsTags: input.needsTagging,
  };
}
