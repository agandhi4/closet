import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { type ImageVariant, parseStoredName } from './image-variant';

// Variant URLs carry `?v=<file.version>` (imageUrl()), which is what makes a
// year of immutable caching safe: rewritten bytes are only ever reached
// through a new version.
const IMMUTABLE_YEAR = 'public, max-age=31536000, immutable';
// Share previews are addressed by the photo's share id, which never changes
// with its bytes: a day, so a crawler's copy catches up with a mask edit.
const SHARE_PREVIEW_CACHE = 'public, max-age=86400';

// Validated by the handler, not the schema: anything that is not a photo
// name is a 404 like a missing photo, never a 400 that confirms the route.
const FileParams = Type.Object({ fileName: Type.String() });
const ShareParams = Type.Object({ shareableId: Type.String() });

/**
 * /file/**: photo variants and share-preview images. Public: every path here
 * is under the /file/ static prefix (static-prefixes.ts), so the root hook
 * resolves no session and builds no page context, and a page added here
 * would render without one. Photos are addressed by unguessable UUID names;
 * share previews and Open Graph images must load for anyone. Failures answer
 * the error handler's bare `{ statusCode, message }` (no page context).
 */
export const fileRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { photos, logger },
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
    reply: FastifyReply,
  ) => {
    if (parseStoredName(fileName)?.variant !== 'original') {
      throw new HttpError(404);
    }
    const stream = await photos.getVariant(fileName, variant);
    return sendImage(reply, stream, 'image/webp', IMMUTABLE_YEAR);
  };

  // Fastify answers a stream that fails before its headers through the
  // error handler and destroys one that fails later; either way the failure
  // is logged here, since the Fastify instance's own logger is silent.
  const sendImage = (
    reply: FastifyReply,
    stream: Readable,
    contentType: string,
    cacheControl: string,
  ) => {
    stream.on('error', (error) =>
      logger.error(
        `Streaming ${reply.request.url} failed`,
        error instanceof Error ? error.stack : String(error),
      ),
    );
    return reply
      .header('Cache-Control', cacheControl)
      .type(contentType)
      .send(stream);
  };

  const route = () => ({
    config: { public: true },
    schema: { params: FileParams },
  });
  app.get('/file/:fileName', route(), async (request, reply) =>
    sendVariant(request.params.fileName, 'original', reply),
  );
  app.get('/file/nobg/:fileName', route(), async (request, reply) =>
    sendVariant(request.params.fileName, 'nobg', reply),
  );
  app.get('/file/thumb/:fileName', route(), async (request, reply) =>
    sendVariant(request.params.fileName, 'thumb', reply),
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
