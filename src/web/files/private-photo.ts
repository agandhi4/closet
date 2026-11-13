import type { FastifyReply } from 'fastify';
import type { Logger } from '../../logger';
import { NotFound, type Resource } from '../refusals';
import {
  type ImageVariant,
  parseStoredName,
  unkeyedPhoto,
} from './image-variant';
import type { Photos } from './photos';

/**
 * Serving a photo only its owner may see: an outfit selfie (GET /selfies/*,
 * src/web/selfies) and a saved look's (GET /inspiration/photo/*, and to a
 * device token GET /api/v1/look-photos/*, src/web/inspiration). Never under the public /file/** (which refuses
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

/** A refused photo is never cached, so a later grant or upload is seen. */
const refuse = (reply: FastifyReply): FastifyReply =>
  reply.header('Cache-Control', 'no-store');

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
 * URL. An <img> reads nothing of it anyway. The pages' answer; the API's
 * is servePrivatePhoto.
 */
export async function sendPrivatePhoto(
  deps: { photos: Photos; logger: Logger },
  reply: FastifyReply,
  request: PrivatePhotoRequest,
): Promise<FastifyReply> {
  if (!(await isServablePrivatePhoto(deps, request))) {
    return refuse(reply.status(404)).send();
  }
  return streamPrivatePhoto(deps, reply, request);
}

/**
 * The API's answer (GET /api/v1/look-photos/{fileName}, #193d): the same
 * check, refused (`no-store`, as the page's) as `refusal`'s NotFound, a problem 404 that names nothing
 * (the error handler's on the api surface, never the error page).
 */
export async function servePrivatePhoto(
  deps: { photos: Photos; logger: Logger },
  reply: FastifyReply,
  request: PrivatePhotoRequest,
  refusal: Resource,
): Promise<FastifyReply> {
  if (!(await isServablePrivatePhoto(deps, request))) {
    refuse(reply);
    throw new NotFound(refusal);
  }
  return streamPrivatePhoto(deps, reply, request);
}

/** Whether `fileName` is an original's name and the owner's photo of this kind: one statement. */
async function isServablePrivatePhoto(
  { logger }: { logger: Logger },
  { fileName, ownerId, kind, isOwn }: PrivatePhotoRequest,
): Promise<boolean> {
  if (
    parseStoredName(fileName)?.variant === 'original' &&
    (await isOwn(fileName, ownerId))
  ) {
    return true;
  }
  logger.debug(`${kind} photo ${fileName} is not user ${ownerId}'s`);
  return false;
}

/** The photo's bytes, `private, immutable`: only after isServablePrivatePhoto said yes. */
async function streamPrivatePhoto(
  { photos, logger }: { photos: Photos; logger: Logger },
  reply: FastifyReply,
  { fileName, variant, kind }: PrivatePhotoRequest,
): Promise<FastifyReply> {
  const stream = await photos.getVariant(unkeyedPhoto(fileName), variant);
  stream.on('error', (error) =>
    logger.error({ err: error }, `Streaming ${kind} photo ${fileName} failed`),
  );
  return reply
    .header('Cache-Control', PRIVATE_IMMUTABLE_YEAR)
    .type('image/webp')
    .send(stream);
}
