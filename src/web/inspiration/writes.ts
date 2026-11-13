import type {
  Multipart,
  MultipartFile,
  MultipartValue,
} from '@fastify/multipart';
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
import { LINK_INPUT_MAX } from '../wardrobe/link-import/link-text';
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
 * the look keeps its whole picture (no cutout is queued). The share
 * confirmation also posts the share's `url` and `title` (sharedSource);
 * any other field is ignored. Answers its id.
 */
export async function addUploadedInspiration(
  { db, photos, logger }: InspirationDeps,
  ownerId: number,
  parts: AsyncIterable<Multipart>,
): Promise<number> {
  const fields = new Map<string, MultipartValue>();
  const photo = await photos.storeUploadParts(filesOf(parts, fields), ownerId);
  if (!photo) throw new HttpError(400, 'No file uploaded');
  // Inside the commit, so a refused field deletes the stored bytes.
  const id = await commitPhoto({ photos, logger }, photo, () =>
    saveInspiration(db, ownerId, photo, sharedSource(fields)),
  );
  logger.info(
    `Inspiration ${id} saved by user ${ownerId} from an upload: ${photo.fileName}`,
  );
  return id;
}

/** The parts' files, in order, noting the text fields as they pass. */
async function* filesOf(
  parts: AsyncIterable<Multipart>,
  fields: Map<string, MultipartValue>,
): AsyncIterable<MultipartFile> {
  for await (const part of parts) {
    if (part.type === 'file') yield part;
    else fields.set(part.fieldname, part);
  }
}

/**
 * The look's link and title from the share confirmation's fields. Stored
 * data, so a link that is not one absolute http(s) URL, a title past the
 * column, or a value busboy cut at LINK_INPUT_MAX is a 400; blank is none.
 */
function sharedSource(fields: Map<string, MultipartValue>): {
  title: string | null;
  sourceUrl: string | null;
} {
  const text = (name: string): string => {
    const field = fields.get(name);
    if (!field) return '';
    if (typeof field.value !== 'string' || field.valueTruncated) {
      throw new HttpError(400, `The ${name} is too long`);
    }
    return field.value.trim();
  };
  const url = text('url');
  const title = text('title');
  if (url && !isHttpUrl(url)) throw new HttpError(400, 'Not an http(s) link');
  if (title.length > INSPIRATION_TITLE_MAX) {
    throw new HttpError(400, 'The title is too long');
  }
  return { title: title || null, sourceUrl: url || null };
}

/** As the column's check reads it (`^https?://`), and one that parses. */
function isHttpUrl(value: string): boolean {
  return (
    value.length <= LINK_INPUT_MAX &&
    /^https?:\/\/\S+$/i.test(value) &&
    URL.canParse(value)
  );
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
