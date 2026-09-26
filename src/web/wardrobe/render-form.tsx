import type { FastifyReply } from 'fastify';
import type { Db } from '../../db/client';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import { categoryLabel, categorySuggestions } from './garment';
import { type GarmentFormModel, GarmentFormPage } from './garment-form';
import { filterOptions } from './queries';

/** A garment form to render: the model without its suggestions, and where they come from. */
export interface GarmentFormRequest extends Omit<
  GarmentFormModel,
  'categories'
> {
  /** The wardrobe whose categories are suggested: where the garment lands. */
  suggestionsFrom: number;
}

/**
 * The garment form page (new, edit, clone, and a new one prefilled from a
 * link): the wardrobe routes and the link import's (link-import/routes.tsx)
 * both end here.
 */
export async function renderGarmentForm(
  reply: FastifyReply,
  db: Db,
  { suggestionsFrom, ...model }: GarmentFormRequest,
  status = 200,
): Promise<FastifyReply> {
  const { categories } = await filterOptions(db, suggestionsFrom);
  return renderPage(
    reply,
    <GarmentFormPage
      ctx={viewContext(reply)}
      model={{
        ...model,
        categories: categorySuggestions(categories).map((value) => ({
          value,
          label: categoryLabel(value),
        })),
      }}
    />,
    { status },
  );
}
