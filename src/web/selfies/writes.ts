import type { MultipartFile } from '@fastify/multipart';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { IsoDate } from '../calendar/calendar-date';
import { ownEntryDay } from '../calendar/queries';
import { HttpError } from '../errors';
import { unkeyedPhoto } from '../files/image-variant';
import type { Photos } from '../files/photos';
import type { NewPhotoRow } from '../files/queries';
import { deleteSelfie, type SelfieOutcome, setEntrySelfie } from './queries';

/**
 * The selfie writes that involve photo bytes, which a transaction cannot
 * roll back (CLAUDE.md Gotchas, the commit contract): Photos stores the
 * bytes and returns the row; setEntrySelfie inserts it with the selfie and
 * the entry's worn mark in one transaction; bytes of a refused or failed
 * write are deleted, and bytes a committed write replaced or removed are
 * unlinked after the commit.
 */

export interface SelfieDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
}

function entryNotFound(): HttpError {
  return new HttpError(404, 'Calendar entry not found');
}

function notYetWorn(): HttpError {
  return new HttpError(409, 'A planned day cannot be marked worn yet');
}

/**
 * POST /calendar/:id/selfie: the multipart `photo` becomes the owner's
 * entry's selfie and the entry is marked worn. The entry is looked up
 * before the body is read, so a refused upload stores nothing: another
 * user's entry is a 404 (ids reveal nothing), a day after today a 409
 * (it cannot be worn yet). HEIC and every other format go through Photos'
 * one pipeline; the selfie keeps its background (no cutout is queued).
 * Answers the entry's day, for the redirect.
 */
export async function attachSelfie(
  { db, photos, logger }: SelfieDeps,
  input: {
    entryId: number;
    ownerId: number;
    parts: AsyncIterable<MultipartFile>;
    today: IsoDate;
  },
): Promise<IsoDate> {
  const { entryId, ownerId, today } = input;
  const day = await ownEntryDay(db, entryId, ownerId);
  if (day === undefined) throw entryNotFound();
  if (day > today) throw notYetWorn();
  const photo = await photos.storeUploadParts(input.parts, ownerId);
  if (!photo) throw new HttpError(400, 'No file uploaded');
  const outcome = await commitSelfie({ db, photos, logger }, photo, () =>
    setEntrySelfie(db, { entryId, ownerId, photo, at: new Date(), today }),
  );
  const { selfieId, replaced, worn } = outcome;
  const wornNote = worn.changed
    ? `entry marked worn (${worn.wears} wears logged)`
    : 'entry already worn';
  logger.info(
    `Selfie ${selfieId} of calendar entry ${entryId} ${replaced ? 'replaced' : 'taken'} by user ${ownerId}: ${photo.fileName}; ${wornNote}`,
  );
  if (replaced) await photos.deleteVariants(unkeyedPhoto(replaced));
  return outcome.day;
}

/**
 * Runs the selfie's write for bytes already stored: if it throws (rolled
 * back) or refuses (the entry went, or its day is ahead, between the
 * look-up and the write), the new bytes go, since nothing points at them.
 */
async function commitSelfie(
  { photos, logger }: SelfieDeps,
  photo: NewPhotoRow,
  write: () => Promise<SelfieOutcome>,
): Promise<Exclude<SelfieOutcome, string>> {
  let outcome: SelfieOutcome;
  try {
    outcome = await write();
  } catch (error) {
    logger.warn(`Rolled back; removing orphaned selfie ${photo.fileName}`);
    await photos.deleteVariants(unkeyedPhoto(photo.fileName));
    throw error;
  }
  if (outcome === 'not-found' || outcome === 'future') {
    await photos.deleteVariants(unkeyedPhoto(photo.fileName));
    throw outcome === 'not-found' ? entryNotFound() : notYetWorn();
  }
  return outcome;
}

/**
 * POST /selfies/:id/delete: removes the owner's selfie (an entry's, or a
 * look kept after its outfit was deleted), row then bytes. False when it is
 * not theirs.
 */
export async function removeSelfie(
  { db, photos, logger }: SelfieDeps,
  selfieId: number,
  ownerId: number,
): Promise<boolean> {
  const fileName = await deleteSelfie(db, selfieId, ownerId);
  if (fileName === undefined) return false;
  // Only after commit: an unlink cannot be rolled back.
  await photos.deleteVariants(unkeyedPhoto(fileName));
  logger.info(`Selfie ${selfieId} removed by user ${ownerId}: ${fileName}`);
  return true;
}
