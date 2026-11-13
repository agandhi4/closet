import type { Multipart, MultipartFile } from '@fastify/multipart';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { HttpError } from '../errors';
import { unkeyedPhoto } from '../files/image-variant';
import type { Photos } from '../files/photos';
import type { NewPhotoRow } from '../files/queries';
import type { OutboundFetcher } from '../security/outbound-fetch';
import {
  importLink,
  type LinkImport,
  LinkImportError,
  type LinkImportRefusal,
  REFUSALS,
} from '../wardrobe/link-import/import';
import { SHARED_TEXT_FIELDS, type SharedTextField } from './share-target';
import {
  deleteInspiration,
  findInspiration,
  INSPIRATION_TITLE_MAX,
  saveInspiration,
  saveInspirationWithPendingPhoto,
  setInspirationPhoto,
} from './queries';

/**
 * The saved-look writes that involve photo bytes, which a transaction
 * cannot roll back (src/web/files/AGENTS.md Gotchas, the commit contract):
 * Photos stores the bytes and returns the row; queries.ts inserts it with
 * the look in one transaction; bytes of a refused or failed write are
 * deleted, and bytes a committed write replaced or removed are unlinked
 * after the commit.
 */

export interface InspirationDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
  fetcher: OutboundFetcher;
}

/**
 * Why a pasted link was saved without its photo, which the look's page
 * says once (`?unread=`): the site's refusal (a 502 of REFUSALS: blocked,
 * a timeout, an image it could not decode), or `no-photo`, a page read
 * with no photo among its candidates. The person adds one (a screenshot).
 */
export type UnreadReason = LinkImportRefusal | 'no-photo';

/**
 * POST /inspiration: the multipart `photo` becomes a new look of the
 * owner's. HEIC and every other format go through Photos' one pipeline;
 * the look keeps its whole picture (no cutout is queued). Answers its id.
 */
export async function addUploadedInspiration(
  deps: InspirationDeps,
  ownerId: number,
  parts: AsyncIterable<MultipartFile>,
): Promise<number> {
  const photo = await deps.photos.storeUploadParts(parts, ownerId);
  if (!photo) throw new HttpError(400, 'No file uploaded');
  return savePhotoLook(deps, ownerId, photo, 'an upload');
}

/** A new look of the photo this request stored (the commit contract: commitPhoto). */
async function savePhotoLook(
  { db, photos, logger }: InspirationDeps,
  ownerId: number,
  photo: NewPhotoRow,
  from: 'an upload' | 'a share',
): Promise<number> {
  const id = await commitPhoto({ photos, logger }, photo, () =>
    saveInspiration(db, ownerId, photo, { title: null, sourceUrl: null }),
  );
  logger.info(
    `Inspiration ${id} saved by user ${ownerId} from ${from}: ${photo.fileName}`,
  );
  return id;
}

/** A share's text fields, as posted (absent when not). */
export type SharedText = Partial<Record<SharedTextField, string>>;

/** What a share into the app was: a photo, now a saved look, or text alone (a link, usually). */
export type Shared = { look: number } | { text: SharedText };

/**
 * POST /inspiration/share, the manifest's share target (#22d): a shared
 * photo (the first; a share of several keeps one) becomes a new look of
 * the owner's, as an upload does, its text ignored; without a photo the
 * text fields are answered for the link import, which saves nothing.
 */
export async function addSharedInspiration(
  deps: InspirationDeps,
  ownerId: number,
  parts: AsyncIterable<Multipart>,
): Promise<Shared> {
  const text: SharedText = {};
  const photo = await deps.photos.storeUploadParts(
    filesOf(parts, text),
    ownerId,
  );
  if (!photo) return { text };
  return { look: await savePhotoLook(deps, ownerId, photo, 'a share') };
}

/**
 * A share's file parts, for storeUploadParts, which drains them; its text
 * fields are kept in `text` on the way (any order: a field after the photo
 * is read once the photo's bytes are). Anything else is dropped.
 */
async function* filesOf(
  parts: AsyncIterable<Multipart>,
  text: SharedText,
): AsyncGenerator<MultipartFile> {
  for await (const part of parts) {
    if (part.type === 'file') {
      yield part;
    } else if (isSharedTextField(part.fieldname)) {
      if (typeof part.value === 'string') text[part.fieldname] = part.value;
    }
  }
}

function isSharedTextField(name: string): name is SharedTextField {
  return (SHARED_TEXT_FIELDS as readonly string[]).includes(name);
}

/**
 * POST /inspiration/link: the pasted `link` (linkIn's, http(s)) becomes a
 * new look of the owner's, fetched through importLink like a garment's
 * (the outbound fetcher, its caps, `blocked-by-site`): an image is the
 * look's photo, a page gives its title and its first readable photo. The
 * photo importLink keeps as a pending photo is claimed here, in the look's
 * own transaction. A site that would not give us the page or a photo still
 * keeps the link, with `unread` saying why (most social pages refuse us; a
 * screenshot is the way in). A link the server will not fetch at all (a
 * 400 of REFUSALS: a private address, a port) throws LinkImportError and
 * saves nothing.
 */
export async function addLinkedInspiration(
  deps: InspirationDeps,
  ownerId: number,
  link: string,
): Promise<{ id: number; unread: UnreadReason | undefined }> {
  const { db, logger } = deps;
  const linkOnly = async (unread: UnreadReason, title: string | null) => {
    const id = await saveInspiration(db, ownerId, null, {
      title,
      sourceUrl: link,
    });
    logger.info(
      `Inspiration ${id} saved by user ${ownerId} from a link without its photo (${unread})`,
    );
    return { id, unread };
  };

  let imported: LinkImport;
  try {
    imported = await importLink(deps, link, ownerId);
  } catch (error) {
    if (
      !(error instanceof LinkImportError) ||
      REFUSALS[error.reason].status === 400
    ) {
      throw error;
    }
    return linkOnly(error.reason, null);
  }
  const title =
    imported.kind === 'page' ? titleOf(imported.product.name) : null;
  if (imported.photo === undefined) return linkOnly('no-photo', title);

  const id = await claimLinkPhoto(deps, ownerId, imported.photo, {
    title,
    sourceUrl: link,
  });
  if (id === undefined) return linkOnly('no-photo', title);
  logger.info(
    `Inspiration ${id} saved by user ${ownerId} from a link (${imported.kind}): ${imported.photo}`,
  );
  return { id, unread: undefined };
}

/**
 * The look with the pending photo importLink just kept for `ownerId`
 * (saveInspirationWithPendingPhoto); undefined when it is no longer
 * theirs to claim (evicted by an eleventh import meanwhile): whoever took
 * its pending row deletes its bytes, so none are deleted here.
 */
async function claimLinkPhoto(
  { db, photos }: InspirationDeps,
  ownerId: number,
  fileName: string,
  fields: { title: string | null; sourceUrl: string },
): Promise<number | undefined> {
  // Storage I/O never runs under the name's lock (#141): the bytes are
  // checked first, and stay until whoever takes the pending row.
  const photo = await photos.pendingPhotoRow(fileName, ownerId);
  if (!photo) return undefined;
  return saveInspirationWithPendingPhoto(db, ownerId, photo, fields);
}

/** A page's own title as a look's: trimmed, within the column, null for none. */
function titleOf(name: string | null): string | null {
  const title = name?.trim().slice(0, INSPIRATION_TITLE_MAX).trim();
  return title ? title : null;
}

/**
 * POST /inspiration/:id/photo: the multipart `photo` becomes the owner's
 * look's photo (a link saved without one, or another picture). The look is
 * looked up before the body is read, so a refused upload stores nothing;
 * the replaced photo is unlinked after commit.
 */
export async function attachInspirationPhoto(
  { db, photos, logger }: InspirationDeps,
  id: number,
  ownerId: number,
  parts: AsyncIterable<MultipartFile>,
): Promise<void> {
  await findInspiration(db, id, ownerId);
  const photo = await photos.storeUploadParts(parts, ownerId);
  if (!photo) throw new HttpError(400, 'No file uploaded');
  const { replaced } = await commitPhoto({ photos, logger }, photo, () =>
    setInspirationPhoto(db, id, ownerId, photo),
  );
  logger.info(
    `Inspiration ${id} photo ${replaced ? 'replaced' : 'added'} by user ${ownerId}: ${photo.fileName}`,
  );
  if (replaced) await photos.deleteVariants(unkeyedPhoto(replaced));
}

/** POST /inspiration/:id/delete: the owner's look, row then bytes. */
export async function removeInspiration(
  { db, photos, logger }: InspirationDeps,
  id: number,
  ownerId: number,
): Promise<void> {
  const { photo } = await deleteInspiration(db, id, ownerId);
  // Only after commit: an unlink cannot be rolled back.
  if (photo) await photos.deleteVariants(unkeyedPhoto(photo));
  logger.info(
    `Inspiration ${id} deleted by user ${ownerId}${photo ? ` with its photo ${photo}` : ''}`,
  );
}

/**
 * Runs the write for bytes this request stored: if it throws (rolled back,
 * or refused: the look went between the look-up and the write), the bytes
 * go, since nothing points at them.
 */
async function commitPhoto<T>(
  { photos, logger }: Pick<InspirationDeps, 'photos' | 'logger'>,
  photo: NewPhotoRow,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    logger.warn(`Rolled back; removing orphaned inspiration ${photo.fileName}`);
    await photos.deleteVariants(unkeyedPhoto(photo.fileName));
    throw error;
  }
}

/** `?unread=` as the look's page reads it: URL state, so anything else is no note. */
export function unreadReasonOf(
  value: string | undefined,
): UnreadReason | undefined {
  if (value === 'no-photo') return value;
  return value !== undefined && Object.hasOwn(REFUSALS, value)
    ? (value as LinkImportRefusal)
    : undefined;
}
