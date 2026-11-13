import { type Static, Type } from '@sinclair/typebox';
import { withoutNulls } from '../api/resource';
import { apiSelfieUrl, type PrivatePhoto } from '../files/image-url';
import { IsoDateSchema } from '../schemas';
import type { SelfieRow } from './queries';

export const SelfiePhoto = Type.Object(
  {
    version: Type.Integer(),
    originalUrl: Type.String(),
    thumbUrl: Type.String({ description: '400 px' }),
  },
  {
    title: 'SelfiePhoto',
    description:
      "An outfit selfie's photo: private, served only to its owner's device token (GET /api/v1/selfie-photos/{fileName}), relative to the server and immutable (a replacement selfie is another photo, so other URLs). Never build or edit one",
  },
);

export function toSelfiePhoto(photo: PrivatePhoto): Static<typeof SelfiePhoto> {
  return {
    version: photo.version ?? 1,
    originalUrl: apiSelfieUrl(photo, 'original'),
    thumbUrl: apiSelfieUrl(photo, 'thumb'),
  };
}

/**
 * The changes feed's selfie (#196b-2, GET /changes): its day, its entry
 * and its photo's URLs. Nothing dropped: a calendar entry's `selfieId` and
 * `selfiePhoto` are read from here (the entry's feed shape has neither).
 */
export const SyncedSelfie = Type.Object(
  {
    id: Type.Integer(),
    day: IsoDateSchema,
    calendarEntryId: Type.Optional(
      Type.Integer({
        description:
          'The entry it was taken of; absent once that outfit was deleted (a look kept on its day)',
      }),
    ),
    photo: SelfiePhoto,
  },
  {
    title: 'SyncedSelfie',
    description: 'An outfit selfie: yours alone, never a grantee’s to read',
  },
);

export function toSyncedSelfie(row: SelfieRow): Static<typeof SyncedSelfie> {
  return withoutNulls({
    id: row.id,
    day: row.day,
    calendarEntryId: row.entryId,
    photo: toSelfiePhoto(row.photo),
  });
}
