import type { FastifyReply } from 'fastify';
import type { Db } from '../../db/client';
import { renderPage } from '../render';
import { brandSizeFor } from '../sizes/queries';
import { viewContext } from '../view-context';
import { replaceableGarments } from '../wishlist/queries';
import { categoryLabel, categorySuggestions } from './garment';
import {
  addsToCloset,
  type GarmentFormModel,
  GarmentFormPage,
  isWishlistForm,
} from './garment-form';
import { closetLookalikes } from './lookalikes';
import { filterOptions } from './queries';

/** A garment form to render: the model without what is read here, and where from. */
export interface GarmentFormRequest extends Omit<
  GarmentFormModel,
  'categories' | 'replaceable' | 'brandSize' | 'lookalikes'
> {
  /** The wardrobe whose categories are suggested: where the garment lands. */
  suggestionsFrom: number;
  /** The duplicate check's "Not the same" ids a refused save posted back. */
  lookalikesDismissed?: readonly number[];
}

/**
 * The garment form page (new, edit, clone, and a new one prefilled from a
 * link): the wardrobe routes and the link import's (link-import/routes.tsx)
 * both end here. A wishlist form also gets its "Replaces" choices, and a
 * form for the requester's own wardrobe the note of the brand it names
 * (#24; never on a shared wardrobe: the notes are the requester's body).
 * A form that adds to the closet gets the duplicate check (#20) for the
 * values it opens with: a link import's, a clone's, a refused save's.
 */
export async function renderGarmentForm(
  reply: FastifyReply,
  db: Db,
  { suggestionsFrom, lookalikesDismissed = [], ...model }: GarmentFormRequest,
  status = 200,
): Promise<FastifyReply> {
  const { values } = model;
  const [{ categories }, replaceable, brandSize, lookalikes] =
    await Promise.all([
      filterOptions(db, suggestionsFrom),
      isWishlistForm(model.mode)
        ? replaceableGarments(
            db,
            suggestionsFrom,
            Number(model.values.replaces) || undefined,
          )
        : undefined,
      // The requester's own wardrobe: suggestionsFrom is the requester.
      model.viewOwner === undefined
        ? brandSizeFor(db, suggestionsFrom, model.values.brand)
        : undefined,
      addsToCloset(model.mode)
        ? closetLookalikes(
            db,
            suggestionsFrom,
            {
              category: values.category,
              type: values.properties.type,
              colors: values.colors,
              brand: values.brand,
            },
            { dismissed: lookalikesDismissed },
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
        brandSize,
        lookalikes: lookalikes && {
          matches: lookalikes,
          dismissed: lookalikesDismissed,
          // A clone lands in the requester's own wardrobe, whatever it was
          // cloned from.
          viewOwner: model.mode.kind === 'clone' ? undefined : model.viewOwner,
        },
        categories: categorySuggestions(categories).map((value) => ({
          value,
          label: categoryLabel(value),
        })),
      }}
    />,
    { status },
  );
}
