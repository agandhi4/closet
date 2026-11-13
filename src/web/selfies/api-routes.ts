import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { IsoDateSchema, RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { attachSelfie, removeSelfie } from './writes';

const IdParams = Type.Object({ id: RowId });

const SelfieUpload = Type.Object(
  {
    photo: Type.String({
      format: 'binary',
      description:
        'The mirror photo: JPEG, PNG, WebP, HEIC or AVIF, at most 64 megapixels; kept with its background',
    }),
  },
  { title: 'SelfieUpload' },
);

const SelfieTaken = Type.Object(
  {
    selfieId: Type.Integer(),
    day: IsoDateSchema,
    replaced: Type.Boolean({
      description: "It replaced the entry's last selfie, which is gone",
    }),
    worn: Type.Object(
      {
        changed: Type.Boolean({ description: 'False: it was worn already' }),
        wears: Type.Integer({
          minimum: 0,
          description: 'Garment wears logged by marking it',
        }),
      },
      {
        title: 'SelfieEntryWorn',
        description: 'Taking it says the entry was worn: it is marked so',
      },
    ),
  },
  { title: 'SelfieTaken' },
);

/**
 * Outfit selfies on /api/v1 (#193c; plan section 6), registered by
 * apiPlugin, each calling what its page twin calls (writes.ts, which
 * takes the Actor and refuses itself). The owner's alone, like the
 * calendar (AGENTS.md): there is no `?ownerId=`, and another's entry or
 * selfie is the 404 of an unknown id, refused before the upload is read.
 * The bytes are never public: no route here signs a URL of them.
 */
export const selfieApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, photos, config, logger },
  done,
) => {
  const deps = { db, photos, logger };

  app.put(
    '/calendar-entries/:id/selfie',
    {
      schema: {
        operationId: 'setCalendarEntrySelfie',
        tags: ['selfies'],
        summary: "Takes an entry's outfit selfie",
        description:
          "multipart/form-data with one `photo` part (a second file is a 413; an image it cannot read a 400). It marks the entry worn, and replaces the entry's last selfie. Another's entry is a 404 and a day still to come a 409, both before the photo is read. Each call stores a new photo.",
        params: IdParams,
        multipartBody: SelfieUpload,
        response: apiResponses({ 200: SelfieTaken }),
      },
    },
    async (request) => {
      // attachSelfie logs the selfie and the entry's worn mark.
      const taken = await attachSelfie(deps, actorOf(request), {
        entryId: request.params.id,
        // One file: the photo (a second is a 413).
        parts: request.files({ limits: { files: 1 } }),
        today: todayIn(config.timeZone, new Date()),
        via: ' (API)',
      });
      return {
        selfieId: taken.selfieId,
        day: taken.day,
        replaced: taken.replaced,
        worn: { changed: taken.worn.changed, wears: taken.worn.wears },
      };
    },
  );

  app.delete(
    '/selfies/:id',
    {
      schema: {
        operationId: 'deleteSelfie',
        tags: ['selfies'],
        summary: 'Removes an outfit selfie',
        description:
          "An entry's, or a look kept on its day after its outfit changed or went. The entry stays worn. A selfie already gone is a 404, which a retry may read as done.",
        params: IdParams,
        response: apiResponses({ 204: Type.Null({ description: 'Removed' }) }),
      },
    },
    async (request, reply) => {
      // removeSelfie logs the removal.
      await removeSelfie(deps, actorOf(request), request.params.id, ' (API)');
      return reply.status(204).send(null);
    },
  );

  done();
};
