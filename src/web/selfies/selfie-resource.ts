import { type Static, Type } from '@sinclair/typebox';
import { apiSelfieUrl, type PrivatePhoto } from '../files/image-url';

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
