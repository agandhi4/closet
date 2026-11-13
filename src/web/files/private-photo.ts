import type { FastifyReply } from 'fastify';
import type { Logger } from '../../logger';
import {
  type ImageVariant,
  parseStoredName,
  unkeyedPhoto,
} from './image-variant';
import type { Photos } from './photos';

/**
 * Serving a photo only its owner may see: an outfit selfie (GET /selfies/*,
 * src/web/selfies) and a saved look's (GET /inspiration/photo/*,
 * src/web/inspiration). Never under the public /file/** (which refuses
 * their names, publicPhoto): a private photo is more personal than a
 * garment's, and an unguessable name is a capability anyone it reaches
 * holds for good.
 *
 * The URL carries `?v=<file.version>` like every photo URL (selfieUrl,
 * inspirationPhotoUrl), so the bytes are immutable for a year; `private`
 * keeps them out of any shared cache. The service worker never stores one
 * (no image route of its matches these paths, and its page cache keeps
 * only HTML), so the browser's own HTTP cache holds them: offline they
 * still show, and signing out empties it (Clear-Site-Data: "cache").
 */
const PRIVATE_IMMUTABLE_YEAR = 'private, max-age=31536000, immutable';

export interface PrivatePhotoRequest {
  fileName: string;
  /** Private photos have no cutout, so no nobg. */
  variant: Exclude<ImageVariant, 'nobg'>;
  ownerId: number;
  /** For the log lines: "Selfie", "Inspiration". */
  kind: string;
  /** Whether `fileName` is the owner's photo of this kind: one statement. */
  isOwn: (fileName: string, ownerId: number) => Promise<boolean>;
}

/**
 * Streams the photo when it is the owner's; anything else (not a photo
 * name, not this kind of photo, someone else's) is the same bare 404, never
 * the error page, which would echo the name back in its path and canonical
 * URL. An <img> reads nothing of it anyway.
 */
export async function sendPrivatePhoto(
  { photos, logger }: { photos: Photos; logger: Logger },
  reply: FastifyReply,
  request: PrivatePhotoRequest,
): Promise<FastifyReply> {
  const { fileName, variant, ownerId, kind } = request;
  if (
    parseStoredName(fileName)?.variant !== 'original' ||
    !(await request.isOwn(fileName, ownerId))
  ) {
    logger.debug(`${kind} photo ${fileName} is not user ${ownerId}'s`);
    return reply.status(404).header('Cache-Control', 'no-store').send();
  }
  const stream = await photos.getVariant(unkeyedPhoto(fileName), variant);
  stream.on('error', (error) =>
    logger.error({ err: error }, `Streaming ${kind} photo ${fileName} failed`),
  );
  return reply
    .header('Cache-Control', PRIVATE_IMMUTABLE_YEAR)
    .type('image/webp')
    .send(stream);
}
