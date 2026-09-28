import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import {
  type ImageVariant,
  parseStoredName,
  unkeyedPhoto,
} from '../files/image-variant';
import type { WebOptions } from '../plugin';
import { RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { isOwnSelfie } from './queries';
import { attachSelfie, removeSelfie } from './writes';

/**
 * Outfit selfies (#19): taking one for a calendar entry (which marks it
 * worn), removing one, and the images themselves. Everything is the
 * signed-in owner's own, like the calendar: another user's entry, selfie or
 * photo name is a 404, whatever wardrobe is shared.
 *
 * Validation: `returnTo` is where a plain post goes back to (the calendar
 * week, Today, the outfit page), through safeReturnTo; anything else falls
 * back to the entry's week. The upload reads it from the query string
 * because Photos drains every multipart part but the photo unread.
 */
const EntryParams = Type.Object({ id: RowId });
const SelfieParams = Type.Object({ id: RowId });
const ReturnTo = Type.String({ maxLength: 2048 });
const ReturnQuery = Type.Object({ returnTo: Type.Optional(ReturnTo) });
// null: a post without a body (Fastify validates a missing body as null).
const ReturnBody = Type.Union([
  Type.Object({ returnTo: Type.Optional(ReturnTo) }),
  Type.Null(),
]);
// Checked by the handler, like /file/**: anything that is not a photo name
// is a 404 like a missing photo.
const FileParams = Type.Object({ fileName: Type.String() });

/**
 * Selfies are served to their owner only, never under the public /file/**
 * (which refuses their names): a mirror photo is more personal than a
 * garment's, and an unguessable name is a capability anyone it reaches
 * holds for good. The URL carries `?v=<file.version>` like every photo URL
 * (selfieUrl), so the bytes are immutable for a year; `private` keeps them
 * out of any shared cache. The service worker never stores one (no image
 * route matches /selfies/, and its page cache keeps only HTML), so the
 * browser's own HTTP cache holds them: offline they still show, and signing
 * out empties it (Clear-Site-Data: "cache").
 */
const PRIVATE_IMMUTABLE_YEAR = 'private, max-age=31536000, immutable';

export const selfieRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, photos, config, logger },
  done,
) => {
  const deps = { db, photos, logger };

  // The camera or library button on a calendar row, a Today card or the
  // selfie dialog: a native multipart post, 303 back where it came from.
  app.post(
    '/calendar/:id/selfie',
    { schema: { params: EntryParams, querystring: ReturnQuery } },
    async (request, reply) => {
      const day = await attachSelfie(deps, {
        entryId: request.params.id,
        ownerId: sessionUserId(request),
        // One file: the photo (a second is a 413).
        parts: request.files({ limits: { files: 1 } }),
        today: todayIn(config.timeZone, new Date()),
      });
      return reply.redirect(
        safeReturnTo(request.query.returnTo, `/calendar?week=${day}`),
        303,
      );
    },
  );

  app.post(
    '/selfies/:id/delete',
    { schema: { params: SelfieParams, body: ReturnBody } },
    async (request, reply) => {
      const removed = await removeSelfie(
        deps,
        request.params.id,
        sessionUserId(request),
      );
      if (!removed) throw new HttpError(404, 'Selfie not found');
      return reply.redirect(
        safeReturnTo(request.body?.returnTo, '/calendar'),
        303,
      );
    },
  );

  const sendSelfie = async (
    fileName: string,
    variant: Exclude<ImageVariant, 'nobg'>,
    ownerId: number,
    reply: FastifyReply,
  ) => {
    // An <img> gets a bare 404, not the error page (which would echo the
    // name back in its path and canonical URL): not a photo name, not a
    // selfie, or someone else's are all the same miss.
    if (
      parseStoredName(fileName)?.variant !== 'original' ||
      !(await isOwnSelfie(db, fileName, ownerId))
    ) {
      logger.debug(`Selfie photo ${fileName} is not user ${ownerId}'s`);
      return reply.status(404).header('Cache-Control', 'no-store').send();
    }
    const stream = await photos.getVariant(unkeyedPhoto(fileName), variant);
    stream.on('error', (error) =>
      logger.error({ err: error }, `Streaming selfie ${fileName} failed`),
    );
    return reply
      .header('Cache-Control', PRIVATE_IMMUTABLE_YEAR)
      .type('image/webp')
      .send(stream);
  };

  app.get(
    '/selfies/:fileName',
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendSelfie(
        request.params.fileName,
        'original',
        sessionUserId(request),
        reply,
      ),
  );
  app.get(
    '/selfies/thumb/:fileName',
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendSelfie(
        request.params.fileName,
        'thumb',
        sessionUserId(request),
        reply,
      ),
  );

  done();
};
