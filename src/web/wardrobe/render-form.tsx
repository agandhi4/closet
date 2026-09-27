import type { FastifyReply } from 'fastify';
import type { Db } from '../../db/client';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import { replaceableGarments } from '../wishlist/queries';
import { categoryLabel, categorySuggestions } from './garment';
import {
  type GarmentFormModel,
  GarmentFormPage,
  isWishlistForm,
} from './garment-form';
import { filterOptions } from './queries';

/** A garment form to render: the model without what is read here, and where from. */
export interface GarmentFormRequest extends Omit<
  GarmentFormModel,
  'categories' | 'replaceable'
> {
  /** The wardrobe whose categories are suggested: where the garment lands. */
  suggestionsFrom: number;
}

/**
 * The garment form page (new, edit, clone, and a new one prefilled from a
 * link): the wardrobe routes and the link import's (link-import/routes.tsx)
 * both end here. A wishlist form also gets its "Replaces" choices.
 */
export async function renderGarmentForm(
  reply: FastifyReply,
  db: Db,
  { suggestionsFrom, ...model }: GarmentFormRequest,
  status = 200,
): Promise<FastifyReply> {
  const [{ categories }, replaceable] = await Promise.all([
    filterOptions(db, suggestionsFrom),
    isWishlistForm(model.mode)
      ? replaceableGarments(
          db,
          suggestionsFrom,
          Number(model.values.replaces) || undefined,
        )
      : undefined,
  ]);
  return renderPage(
    reply,
    <GarmentFormPage
      ctx={viewContext(reply)}
      model={{
        ...model,
        replaceable,
        categories: categorySuggestions(categories).map((value) => ({
          value,
          label: categoryLabel(value),
        })),
      }}
    />,
    { status },
  );
}
