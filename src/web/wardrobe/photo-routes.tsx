import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { recordCutoutEvent } from '../../cutout/queries';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import { imageUrl } from '../files/image-url';
import {
  draftsHeld,
  MAX_DRAFTS_PER_USER,
  pendingPhotoOf,
} from '../files/pending-photos';
import type { WebOptions } from '../plugin';
import { renderFragment } from '../render';
import { authorizeGarmentWardrobe, requireGarment } from './garment-access';
import { GarmentPhotoView } from './garment-page';
import { batchEnd } from './draft-redirects';
import { nextDraft } from './draft-queue';
import { draftNotFound } from './render-form';
import {
  DRAFT_DISCARD_PATH,
  draftUrl,
  garmentUrl,
  PHOTO_ADD_PATH,
  wardrobeUrl,
  readIdList,
} from './urls';
import {
  discardPendingPhoto,
  replacePhoto,
  rotateGarmentPhoto,
  stagePhotoUploads,
  type WardrobeDeps,
} from './writes';
import { DiscardDraftBody, RotateBody } from './garment-schemas';
import { GarmentParams, OwnerQuery } from '../schemas';

/**
 * A garment's photo: the add sheet's upload and a draft's Discard, the
 * photo sheet's replace and rotate, the mask editor's save, and the
 * cutout's polling and retry. Every route takes `?ownerId=` for a shared
 * wardrobe (authorizeGarmentWardrobe).
 */
export const photoRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;
  const deps: WardrobeDeps = {
    db,
    photos: options.photos,
    logger,
    cutouts: options.cutouts,
  };

  // The add sheet's camera and library (#97): the photo, stored as the
  // requester's pending photo (stagePhotoUploads: the upload path every
  // garment photo takes, then the pending row), and a 303 to the new
  // garment form carrying it, whose save claims it and queues its cutout.
  // A library pick of several (#200) is a batch of drafts instead, and the
  // 303 opens the first. Adding is a write: the wardrobe is checked before
  // the body is read, so a refused upload stores nothing, and so is the
  // room left for drafts: the parser stops at the first photo past it (one
  // photo always fits: it is not a draft). A native post (PostForm): a
  // refused photo is the error page, which htmx would not swap.
  app.post(
    PHOTO_ADD_PATH,
    { schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const userId = sessionUserId(request);
      const room = MAX_DRAFTS_PER_USER - (await draftsHeld(db, userId));
      const staged = await stagePhotoUploads(
        deps,
        request.files({ limits: { files: Math.max(room, 1) } }),
        userId,
        access.ownerId,
      );
      return reply.redirect(
        staged.kind === 'single'
          ? wardrobeUrl(viewOwner, { photo: staged.fileName }, '/wardrobe/new')
          : draftUrl(viewOwner, staged.first, [], staged.leftOut),
        303,
      );
    },
  );

  // A draft's Discard (#200): the photo goes (discardPendingPhoto: only the
  // requester's own, still pending, in the wardrobe its batch was uploaded
  // for) and the queue moves on to the next draft after it, or ends as a
  // save of the last one would. Nothing to discard (saved or discarded
  // already, a second tap) ends the queue the same way; the requester's
  // draft for another wardrobe is a 404, as on the form and the save.
  app.post(
    DRAFT_DISCARD_PATH,
    { schema: { querystring: OwnerQuery, body: DiscardDraftBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const scope = { userId: sessionUserId(request), ownerId: access.ownerId };
      const { photo } = request.body;
      const saved = readIdList(request.body.saved);
      // Drafts only: a single pending photo is never this button's. The
      // take answers the drafts still waiting, so the next is read with it.
      const discarded = await discardPendingPhoto(deps, photo, scope, {
        draftsOnly: true,
      });
      const draft = discarded?.draft;
      // Nothing taken: a draft of another wardrobe is a 404, as on the form.
      if (
        !draft &&
        (await pendingPhotoOf(db, photo, scope)) === 'otherWardrobe'
      ) {
        throw draftNotFound();
      }
      const next = draft && nextDraft(draft.waiting, draft.position);
      return reply.redirect(
        next
          ? draftUrl(viewOwner, next, saved)
          : batchEnd(logger, viewOwner, saved),
        303,
      );
    },
  );

  // The garment page's photo while its cutout is pending polls this
  // (hx-trigger every 2s) and swaps it in; the answer stops polling once
  // the cutout is ready or failed.
  app.get(
    '/wardrobe/:id/cutout',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'view',
      );
      const garment = await requireGarment(
        db,
        request.params.id,
        access.ownerId,
      );
      return renderFragment(
        reply,
        <GarmentPhotoView
          garment={garment}
          viewOwner={viewOwner}
          canEdit={access.canManage}
        />,
      );
    },
  );

  // "Try again" on a failed cutout: a native post (PostForm), answered
  // with the garment page, which shows it pending. Idempotent: a cutout
  // that is no longer failed is left alone, a pending one included (its
  // job may be running: src/cutout/state.ts).
  app.post(
    '/wardrobe/:id/cutout/retry',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const garment = await requireGarment(db, id, access.ownerId);
      if (!garment.photo) throw new HttpError(400, 'Garment has no photo');
      const outcome = await recordCutoutEvent(db, garment.photo.fileName, {
        type: 'retry',
      });
      if (outcome.ok) {
        logger.info(
          `Garment ${id} cutout requeued by user ${sessionUserId(request)}`,
        );
        options.cutouts.wake();
      } else {
        logger.info(`Garment ${id} cutout retry ignored (${outcome.reason})`);
      }
      return reply.redirect(garmentUrl(id, viewOwner), 303);
    },
  );

  // The photo sheet's native multipart post: the photo; its cutout is
  // queued; 303 to the garment. The garment is checked before the body is
  // read, so a refused upload stores nothing, and a refusal is the error
  // page (htmx dropped it). Pages cached before 2026-09-27 still hx-post:
  // they get the HX-Redirect they wait for. Two files: pages cached before
  // server-side removal also send the browser's cutout (nobgPhoto), which
  // storeUploadParts drains and ignores; a third file would be a 413.
  app.post(
    '/wardrobe/:id/photo',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      await requireGarment(db, id, access.ownerId);
      await replacePhoto(
        deps,
        id,
        access.ownerId,
        request.files({ limits: { files: 2 } }),
      );
      const saved = garmentUrl(id, viewOwner, '', { photoSaved: 1 });
      if (request.headers['hx-request']) {
        return reply.header('HX-Redirect', saved).status(200).send();
      }
      return reply.redirect(saved, 303);
    },
  );

  // The photo sheet's ↺ and ↻: a native post (PostForm), 303 back to the
  // garment with ?photoRotated=1, which opens the sheet again so the next
  // quarter turn is one tap. The photo is replaced by a turned copy as an
  // upload replaces it (rotateGarmentPhoto); a photo that changed
  // meanwhile is a 409.
  app.post(
    '/wardrobe/:id/photo/rotate',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: RotateBody,
      },
    },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const garment = await requireGarment(db, id, access.ownerId);
      if (!garment.photo) throw new HttpError(400, 'Garment has no photo');
      await rotateGarmentPhoto(
        deps,
        id,
        access.ownerId,
        garment.photo,
        request.body.direction,
      );
      return reply.redirect(
        garmentUrl(id, viewOwner, '', { photoRotated: 1 }),
        303,
      );
    },
  );

  // The mask editor's save (public/js/mask-editor.js): the edited cutout
  // replaces the stored one; the answer is the photo's new URLs (signed:
  // imageUrl), which the page points at. `version` stays for a page whose
  // script predates them (it rewrites `v`, which the signature covers, so
  // /file answers that through the row).
  app.post(
    '/wardrobe/:id/nobg',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const garment = await requireGarment(db, id, access.ownerId);
      if (!garment.photo) throw new HttpError(400, 'Garment has no photo');
      const part = await request.file();
      if (!part) throw new HttpError(400, 'No file uploaded');
      const photo = await options.photos.saveEditedCutout(
        part.file,
        garment.photo.fileName,
      );
      // Its row went (a delete or a photo replaced) after the garment was read.
      if (!photo) throw new HttpError(404);
      logger.info(
        `Garment ${id} cutout replaced, photo version ${photo.version}`,
      );
      return reply.send({
        version: photo.version,
        originalUrl: imageUrl(photo, 'original'),
        nobgUrl: imageUrl(photo, 'nobg'),
      });
    },
  );

  done();
};
