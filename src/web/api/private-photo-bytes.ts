import { CloneType, Type } from '@sinclair/typebox';
import { literals } from './resource';

/**
 * What the API's private photo routes share (GET /look-photos/{fileName},
 * src/web/inspiration/api-routes.ts; GET /selfie-photos/{fileName},
 * src/web/selfies/api-routes.ts): both serve through servePrivatePhoto and
 * count on API_PHOTO_LIMIT (`config.apiPhotoBytes`).
 */

/**
 * The photo's bytes, for the spec: Fastify never serializes a stream, and
 * every refusal is the problem (apiResponses).
 */
export const PhotoBytes = Type.Unsafe<unknown>({
  description: 'The photo, WebP: `private, immutable` for a year',
  content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } },
});

export const PrivatePhotoParams = Type.Object({
  // Checked by the handler, as on the page: anything that is not one of
  // your photos' names is the 404 of a missing photo.
  fileName: Type.String({ maxLength: 64 }),
});

export const PrivatePhotoQuery = Type.Object({
  variant: Type.Optional(
    CloneType(literals(['original', 'thumb'] as const), {
      description: 'The 1080 px original unless `thumb` (400 px)',
    }),
  ),
  v: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "The photo's version, which its URL carries so it is cached for good",
    }),
  ),
});
