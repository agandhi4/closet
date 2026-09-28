import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { type PhotoUrlQuery, signedPhoto } from './image-url';
import { type ImageVariant, parseStoredName } from './image-variant';
import { publicPhoto } from './references';

// A variant URL names its bytes for good (imageUrl: a signed URL names the
// set, and new bytes are a new version, so a new URL), which is what makes
// a year of immutable caching safe. `private` (#229): a photo is its owner's
// wardrobe, reachable without a session only by its unguessable name, so no
// shared cache (a proxy, a CDN) may keep a copy; a share showing it can end,
// and a year-long public copy would outlive it. The browser's own cache
// still keeps it, and is emptied with Clear-Site-Data when the session ends
// or another account signs in over it (src/web/security/CLAUDE.md). The one
// constant for every /file variant, whichever way it was found.
const PRIVATE_IMMUTABLE_YEAR = 'private, max-age=31536000, immutable';
// Share previews are addressed by the photo's share id, which never changes
// with its bytes: a day, so a crawler's copy catches up with a mask edit.
// Public: made for link-preview crawlers, and it carries the watermark.
const SHARE_PREVIEW_CACHE = 'public, max-age=86400';

// Validated by the handler, not the schema: anything that is not a photo
// name is a 404 like a missing photo, never a 400 that confirms the route.
const FileParams = Type.Object({ fileName: Type.String() });
// imageUrl's parameters, checked by signedPhoto; anything else (an old
// page's unsigned URL) is answered through the row.
const FileQuery = Type.Object({
  v: Type.Optional(Type.String()),
  k: Type.Optional(Type.String()),
  s: Type.Optional(Type.String()),
});
const ShareParams = Type.Object({ shareableId: Type.String() });

/**
 * /file/**: photo variants and share-preview images. Public: every path here
 * is under the /file/ static prefix (static-prefixes.ts), so the root hook
 * resolves no session and builds no page context, and a page added here
 * would render without one. Photos are addressed by unguessable UUID names;
 * share previews and Open Graph images must load for anyone. Outfit selfies
 * are the exception: only their owner sees them (GET /selfies/*, session
 * checked, src/web/selfies/routes.ts), so here their names are a 404 like
 * a missing photo, and knowing one is not a way in. Failures answer the
 * error handler's bare `{ statusCode, message }` (no page context).
 *
 * A URL imageUrl signed is served without a statement (#162): the
 * signature proves the name is no selfie's and names the set to serve.
 * Anything else asks the row (publicPhoto), one statement, as every photo
 * request did before.
 */
export const fileRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, photos, logger, metrics },
  done,
) => {
  // The segment must be a photo's base name, `<uuid>.webp`, as defined once
  // by parseStoredName (reconciliation uses the same rule). DATA_PATH also
  // holds app.log: a looser "safe characters" check served it, session
  // cookies included, to anyone. Variant names (`-thumb`, `-nobg`) are
  // reached only through their own routes.
  const sendVariant = async (
    fileName: string,
    variant: ImageVariant,
    query: PhotoUrlQuery,
    reply: FastifyReply,
  ) => {
    if (parseStoredName(fileName)?.variant !== 'original') {
      throw new HttpError(404);
    }
    const signed = signedPhoto(fileName, query);
    if (signed) {
      const stream = await photos.openStoredVariant(signed, variant);
      if (stream) {
        metrics.countPhotoRequest('none');
        return sendImage(reply, stream, 'image/webp', PRIVATE_IMMUTABLE_YEAR);
      }
      // The set is gone (a cutout swap or a rotate retired it, the garment
      // was deleted) or its thumb is still to be made: the row decides.
      // Never the URL: its `s=` is a capability.
      logger.debug(
        `Signed ${variant} of ${fileName} is not in storage; asking the row`,
      );
    }
    // The row names the nobg and thumb it points at (its variant key), so
    // an unsigned `<uuid>.webp?v=` serves whichever set is current.
    const photo = await publicPhoto(db, fileName);
    metrics.countPhotoRequest('row');
    if (!photo) {
      logger.warn(`Refused a selfie on the public /file route: ${fileName}`);
      throw new HttpError(404);
    }
    const stream = await photos.getVariant(photo, variant);
    return sendImage(reply, stream, 'image/webp', PRIVATE_IMMUTABLE_YEAR);
  };

  // Fastify answers a stream that fails before its headers through the
  // error handler and destroys one that fails later; either way the failure
  // is logged here, with the file it was serving: the path alone, since a
  // /file query's `s=` is a capability.
  const sendImage = (
    reply: FastifyReply,
    stream: Readable,
    contentType: string,
    cacheControl: string,
  ) => {
    stream.on('error', (error) =>
      logger.error(
        { err: error },
        `Streaming ${reply.request.url.split('?')[0]} failed`,
      ),
    );
    return reply
      .header('Cache-Control', cacheControl)
      .type(contentType)
      .send(stream);
  };

  const route = () => ({
    config: { public: true },
    schema: { params: FileParams, querystring: FileQuery },
  });
  app.get('/file/:fileName', route(), async (request, reply) =>
    sendVariant(request.params.fileName, 'original', request.query, reply),
  );
  app.get('/file/nobg/:fileName', route(), async (request, reply) =>
    sendVariant(request.params.fileName, 'nobg', request.query, reply),
  );
  app.get('/file/thumb/:fileName', route(), async (request, reply) =>
    sendVariant(request.params.fileName, 'thumb', request.query, reply),
  );

  // The Open Graph image of a shared garment or outfit (src/web/share).
  app.get(
    '/file/watermark/:shareableId',
    { config: { public: true }, schema: { params: ShareParams } },
    async (request, reply) =>
      sendImage(
        reply,
        await photos.watermarked(request.params.shareableId),
        'image/jpeg',
        SHARE_PREVIEW_CACHE,
      ),
  );

  done();
};
