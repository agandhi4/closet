import { HttpError } from '../../errors';
import { t } from '../../i18n';
import { normalizeCategory } from '../../wardrobe/garment';
import {
  importLink,
  type LinkImport,
  LinkImportError,
  REFUSALS,
} from '../../wardrobe/link-import/import';
import { importedForm } from '../../wardrobe/link-import/prefill';
import {
  formPost,
  type GarmentFormValues,
  readGarmentForm,
  withPresets,
} from '../../wardrobe/validation';
import {
  createGarment,
  createGarmentWithLinkPhoto,
  discardLinkPhoto,
  type WardrobeDeps,
  type WithGarment,
} from '../../wardrobe/writes';
import type { EntryStatus } from '../../../wardrobe/status';
import type { ToolContext } from '../tool';

/** What the caller may say instead of the page. */
export interface LinkOverrides {
  url: string;
  /** Where it lands (the tool's default is the wishlist). */
  destination: EntryStatus;
  /** A wishlist item's replaced garment (stored only if the owner's; replacementOf). */
  replacesGarmentId?: number;
  name?: string;
  category?: string;
  type?: string;
  size?: string;
  notes?: string;
}

/** More rows the save writes with the garment (add_candidate's link, 34b). */
export interface LinkSaveOptions {
  withGarment?: WithGarment;
}

/**
 * add_garment_from_link: the link import (#6) and the garment form's save
 * in one step, with nobody to review the form. importLink fetches through
 * the outbound fetcher and stores the first readable photo as the caller's
 * pending photo; importedForm prefills the form as the page does; the
 * caller's overrides replace fields (a new category or type brings its
 * presets, as the form's chips do); then the form's own post goes through
 * readGarmentForm and the save that claims the photo
 * (createGarmentWithLinkPhoto). A refused form discards the photo it
 * fetched. The photo choices the page would offer are not: the first is
 * kept, and the garment page changes it.
 *
 * Lands where the caller says (add_garment_from_link defaults to the
 * wishlist, #18). add_candidate (34b) saves through it too, its candidate
 * link written in the garment's transaction (`withGarment`).
 */
export async function addGarmentFromLink(
  ctx: ToolContext,
  ownerId: number,
  overrides: LinkOverrides,
  { withGarment }: LinkSaveOptions = {},
): Promise<{ id: number; notices: string[] }> {
  const deps: WardrobeDeps = {
    db: ctx.db,
    photos: ctx.photos,
    logger: ctx.webLogger,
    cutouts: ctx.cutouts,
  };
  let imported: LinkImport;
  try {
    imported = await importLink(
      { ...deps, fetcher: ctx.fetcher },
      overrides.url,
      ctx.userId,
    );
  } catch (error) {
    if (!(error instanceof LinkImportError)) throw error;
    ctx.webLogger.warn(
      `Link import by user ${ctx.userId} (MCP) refused (${error.reason})`,
    );
    const refusal = REFUSALS[error.reason];
    // The fetch's failures are the shop's (502s); a tool call is refused.
    throw new HttpError(
      refusal.status < 500 ? refusal.status : 422,
      t(refusal.message),
    );
  }
  const form = importedForm(imported, overrides.url);
  const photo = form.link.photo;
  const posted = formPost(withOverrides(form.values, overrides));
  const read = readGarmentForm(posted);
  if (!read.ok) {
    if (photo) await discardLinkPhoto(deps, photo, ctx.userId);
    const messages = Object.entries(read.errors).map(
      ([field, errors]) => `${field}: ${errors?.join(' ')}`,
    );
    throw new HttpError(400, messages.join('; '));
  }
  const id = photo
    ? await createGarmentWithLinkPhoto(
        deps,
        ownerId,
        ctx.userId,
        read.fields,
        photo,
        overrides.destination,
        withGarment,
      )
    : await createGarment(
        deps,
        ownerId,
        read.fields,
        overrides.destination,
        withGarment,
      );
  if (id === undefined) {
    // Claimed or evicted between the import and the save (the same user's
    // tenth import meanwhile): nothing was written.
    throw new HttpError(409, t('linkImport.PHOTO_GONE'));
  }
  ctx.webLogger.info(
    `Garment ${id} added from a link by user ${ctx.userId} into wardrobe ${ownerId} (${overrides.destination}, MCP): ${imported.kind}${photo ? `, photo ${photo}` : ', no photo'}`,
  );
  return { id, notices: form.link.notices };
}

function withOverrides(
  values: GarmentFormValues,
  overrides: LinkOverrides,
): GarmentFormValues {
  const category =
    overrides.category === undefined
      ? values.category
      : normalizeCategory(overrides.category);
  const type = overrides.type ?? values.properties.type;
  const kindChanged =
    category !== values.category || type !== values.properties.type;
  return {
    ...values,
    name: overrides.name ?? values.name,
    category,
    size: overrides.size ?? values.size,
    notes: overrides.notes ?? values.notes,
    replaces:
      overrides.replacesGarmentId === undefined
        ? values.replaces
        : String(overrides.replacesGarmentId),
    properties: kindChanged
      ? withPresets({ ...values.properties, type }, category)
      : values.properties,
  };
}
