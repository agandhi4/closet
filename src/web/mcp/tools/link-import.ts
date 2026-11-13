import { HttpError } from '../../errors';
import type { FieldErrors } from '../../auth/validation';
import type { GarmentField } from '../../wardrobe/garment-input';
import {
  type LinkOverrides,
  type LinkSaveOptions,
  saveGarmentFromLink,
} from '../../wardrobe/link-import/save';
import type { WardrobeAccess } from '../../sharing/access';
import type { ToolContext } from '../tool';

/**
 * A garment form readGarmentForm refused, as a tool's 400: each field with
 * the messages the form would show under it. Also update_garment's.
 */
export function refusedForm(errors: FieldErrors<GarmentField>): HttpError {
  const messages = Object.entries(errors).map(
    ([field, fieldErrors]) => `${field}: ${fieldErrors?.join(' ')}`,
  );
  return new HttpError(400, messages.join('; '));
}

/**
 * add_garment_from_link and suggest_garment's save: the link import and
 * the garment form's save in one step (saveGarmentFromLink, which the
 * API's link import shares), a refused form as the tool's 400. Lands where
 * the caller says (add_garment_from_link defaults to the wishlist, #18);
 * suggest_garment (#337) writes the suggestion's provenance in the
 * garment's transaction (`withGarment`: markSuggestion, whose refusal rolls
 * the garment back).
 */
export async function addGarmentFromLink(
  ctx: ToolContext,
  access: Pick<WardrobeAccess, 'ownerId' | 'isOwner'>,
  overrides: LinkOverrides,
  options: LinkSaveOptions = {},
): Promise<{ id: number; notices: string[] }> {
  const saved = await saveGarmentFromLink(
    {
      db: ctx.db,
      photos: ctx.photos,
      logger: ctx.webLogger,
      cutouts: ctx.cutouts,
      fetcher: ctx.fetcher,
    },
    ctx.userId,
    access,
    overrides,
    'MCP',
    options,
  );
  if (!saved.ok) throw refusedForm(saved.errors);
  return { id: saved.id, notices: saved.notices };
}
