import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { todayIn } from '../../calendar-date';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { pendingPhotoOf } from '../files/pending-photos';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import { viewContext } from '../view-context';
import { type GoesWithCloset, judgeGoesWithCloset } from '../gallery/ideas';
import { decisionToastOf } from '../wishlist/suggestion-parts';
import type { GoesWithInputs } from '../gallery/queries';
import { normalizeCategory } from './garment';
import { garmentContext } from './garment-context';
import {
  authorizeGarmentWardrobe,
  garmentNotFound,
  requireGarment,
} from './garment-access';
import { GarmentPage } from './garment-page';
import { afterDraft } from './draft-redirects';
import { pendingPhotoView } from './link-import/photo-choice';
import { PropertiesFragment } from './property-fields';
import { repairPanel } from './repairs';
import { setCondition, updateGarmentFields } from './queries';
import {
  destinationValues,
  postedDestination,
  resolveDestination,
} from './destination';
import { formAudience } from './garment-form';
import {
  draftNotFound,
  type GarmentFormRequest,
  renderGarmentForm,
} from './render-form';
import { setGarmentStatus, type StatusChange } from './status';
import { garmentUrl, wardrobeUrl, WISHLIST_PATH, readIdList } from './urls';
import {
  cloneGarment,
  createGarment,
  createGarmentWithPendingPhoto,
  removeGarment,
  type WardrobeDeps,
} from './writes';
import {
  ConditionBody,
  GarmentPageQuery,
  NewGarmentQuery,
  PropertiesFragmentQuery,
} from './garment-schemas';
import {
  formValues,
  GarmentBody,
  type GarmentField,
  propertyFormValues,
  readCondition,
  readGarmentForm,
  storedFormValues,
  withPresets,
} from './garment-input';
import { GarmentParams, OwnerQuery } from '../schemas';

/** Archive and Restore's 409 when the garment's status does not take the event. */
const STATUS_REFUSED: Record<Exclude<StatusChange['event'], 'buy'>, string> = {
  archive: 'Only a garment in the closet can be archived',
  restore: 'Only an archived garment can be restored',
};

/**
 * One garment: the new form and its post, the properties fragment, the
 * garment page, the edit and clone forms and their posts, the condition
 * control, archive, restore and delete. Every route takes `?ownerId=` for a
 * shared wardrobe (authorizeGarmentWardrobe). Adding from a link has its
 * own plugin (link-import/routes.tsx) that ends on the new form.
 */
export const garmentRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger, config } = options;
  const deps: WardrobeDeps = {
    db,
    photos: options.photos,
    logger,
    cutouts: options.cutouts,
  };

  /** The form again, with the posted values and what is wrong with them. */
  async function refuseForm(
    reply: FastifyReply,
    form: GarmentFormRequest & { errors: FieldErrors<GarmentField> },
  ): Promise<FastifyReply> {
    logger.warn(
      `Garment form refused (${form.mode.kind}): ${Object.keys(form.errors).join(', ')}`,
    );
    return renderGarmentForm(reply, db, form, 400);
  }

  // The new garment form: the closet's, or the wishlist's (`?to=wishlist`,
  // prefilled from the garment it replaces with `&replaces=`), or a closet
  // garment bought for a Muse need instead of its picks (`?forNeed=`,
  // prefilled from its best pick). `?photo=` is an add-sheet upload's
  // pending photo, shown only while it is still the
  // requester's (the save's claim is the real check); otherwise the form
  // says it is gone (a back navigation after saving lands here). A draft
  // of a batch (#200) also gets its queue (draft-queue.tsx).
  app.get(
    '/wardrobe/new',
    { schema: { querystring: NewGarmentQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const { destination, prefill, boughtFor } = await resolveDestination(
        db,
        request.query,
        access,
      );
      const { photo } = request.query;
      return renderGarmentForm(reply, db, {
        mode: { kind: 'new', destination },
        suggestionsFrom: access.ownerId,
        viewOwner,
        values: destinationValues(destination, prefill),
        boughtFor,
        pendingPhoto: photo
          ? {
              fileName: photo,
              scope: {
                userId: sessionUserId(request),
                ownerId: access.ownerId,
              },
              sayGone: true,
              carried: {
                saved: readIdList(request.query.saved),
                leftOut: request.query.leftOut ?? [],
              },
            }
          : undefined,
      });
    },
  );

  // The form's properties after its category, a type chip or the weight
  // changed (src/web/wardrobe/property-fields.tsx): both blocks, the second
  // out of band, with presets filled where the user has not chosen. Reads
  // nothing and writes nothing (a POST only because it carries the form).
  app.post(
    '/wardrobe/properties-fragment',
    { schema: { body: PropertiesFragmentQuery } },
    (request, reply) => {
      const category = normalizeCategory(request.body.category ?? '');
      return renderFragment(
        reply,
        <PropertiesFragment
          category={category}
          values={withPresets(propertyFormValues(request.body), category)}
        />,
      );
    },
  );

  // A new garment. A form holding a pending photo (prefilled from a link, or
  // started from an add-sheet upload) also posts it as `linkPhoto` (stored,
  // no row yet), which is claimed here with the garment
  // (createGarmentWithPendingPhoto); a refused form keeps it. A draft of a
  // batch (#200) moves the queue on to the batch's next draft (afterDraft).
  // Statements after the session: the insert alone; with a pending photo,
  // the claim's transaction; a refused form, its one statement.
  app.post(
    '/wardrobe',
    { schema: { querystring: OwnerQuery, body: GarmentBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const { linkPhoto } = request.body;
      const userId = sessionUserId(request);
      const scope = { userId, ownerId: access.ownerId };
      const saved = readIdList(request.body.draftsSaved);
      // An order item or a Muse need is checked before anything is read or
      // stored, and written in the garment's transaction.
      const { destination, boughtFor, withGarment } = await postedDestination(
        db,
        request.body,
        access,
      );
      const status = destination.to;
      const again = {
        mode: { kind: 'new', destination },
        suggestionsFrom: access.ownerId,
        viewOwner,
        link: linkPhoto ? pendingPhotoView(linkPhoto) : undefined,
        boughtFor,
        lookalikesDismissed: readIdList(request.body.lookalikesDismissed),
      } as const;
      const form = readGarmentForm(
        request.body,
        formAudience(again.mode, viewOwner),
      );
      if (!form.ok) {
        return refuseForm(reply, {
          ...again,
          values: form.values,
          errors: form.errors,
          // Its draft's queue, and a draft of another wardrobe's 404.
          pendingPhoto: linkPhoto
            ? {
                fileName: linkPhoto,
                scope,
                sayGone: false,
                carried: { saved, leftOut: [] },
              }
            : undefined,
        });
      }
      // Its page's toast: saved, or for "Bought a different one" the need met.
      const savedFlag = boughtFor ? { decided: 'boughtFor' } : { created: 1 };
      const created = (id: number) =>
        logger.info(
          `Garment ${id} created (${status}) by user ${userId} in wardrobe ${access.ownerId}${
            form.fields.replacesGarmentId
              ? `, asked to replace garment ${form.fields.replacesGarmentId}`
              : ''
          }${
            destination.orderItem
              ? `, from order item ${destination.orderItem}`
              : ''
          }${boughtFor ? `, bought for Muse need ${boughtFor.id}` : ''}`,
        );
      if (!linkPhoto) {
        const id = await createGarment(
          deps,
          access.ownerId,
          form.fields,
          status,
          withGarment,
        );
        created(id);
        return reply.redirect(garmentUrl(id, viewOwner, '', savedFlag), 302);
      }
      const claimed = await createGarmentWithPendingPhoto(
        deps,
        access.ownerId,
        userId,
        form.fields,
        linkPhoto,
        status,
        withGarment,
      );
      if (!claimed) {
        // Why the claim found nothing: a draft of another wardrobe is a
        // 404 (#200), anything else no longer available.
        if ((await pendingPhotoOf(db, linkPhoto, scope)) === 'otherWardrobe') {
          throw draftNotFound();
        }
        return refuseForm(reply, {
          ...again,
          link: pendingPhotoView(undefined),
          values: formValues(request.body),
          errors: { linkPhoto: [t('add.PHOTO_GONE')] },
        });
      }
      const { id, draft } = claimed;
      created(id);
      return draft
        ? reply.redirect(
            afterDraft(logger, viewOwner, linkPhoto, draft, saved, id),
            303,
          )
        : reply.redirect(garmentUrl(id, viewOwner, '', savedFlag), 302);
    },
  );

  /**
   * A wishlist item's "Goes with my closet" (#18b) for its page, judged
   * over the inputs garmentContext read (the owner's alone; undefined
   * otherwise). Logs the search, which is the page's time, not the reads.
   */
  function judgeWishlistItem(
    garmentId: number,
    ownerId: number,
    inputs: GoesWithInputs | undefined,
  ): GoesWithCloset | undefined {
    if (!inputs) return undefined;
    const started = performance.now();
    const judged = judgeGoesWithCloset(inputs);
    if (judged) {
      logger.debug(
        `Goes with my closet for user ${ownerId}: wishlist item ${garmentId} makes ${judged.outfits}${judged.capped ? '+' : ''} outfit(s), ${judged.nearDuplicates.length} near-duplicate(s), in ${Math.round(performance.now() - started)} ms`,
      );
    }
    return judged;
  }

  // Three statements whatever the garment: the session, the garment (what
  // is read next depends on its status), and garmentContext for the rest
  // (garment-context.ts; garment-page.spec.ts counts them).
  app.get(
    '/wardrobe/:id',
    { schema: { params: GarmentParams, querystring: GarmentPageQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'view',
      );
      const { id } = request.params;
      const today = todayIn(config.timeZone, new Date());
      const garment = await requireGarment(db, id, access.ownerId);
      const context = await garmentContext(db, garment, access, today);
      const { own } = context;
      return renderPage(
        reply,
        <GarmentPage
          ctx={viewContext(reply)}
          model={{
            garment,
            today,
            capsules: context.capsules,
            viewOwner,
            wear: own && { summary: own.wear, today },
            replaces: context.replaces,
            replacedBy: context.replacedBy,
            // "Style this" is anyone's who sees a closet garment: Styling
            // browses a shared wardrobe (#42) and saves only one's own.
            styling: {
              canStyle: garment.status === 'closet',
              avoided: own?.avoided ?? [],
            },
            goesWith: judgeWishlistItem(id, access.ownerId, context.goesWith),
            brandSize: context.brandSize,
            outfits: own?.outfits,
            repairs: own?.repairs,
            canEdit: access.canManage,
            canDelete: access.isOwner,
            justCreated: request.query.created === '1',
            justSavedPhoto: request.query.photoSaved === '1',
            justRotatedPhoto: request.query.photoRotated === '1',
            justBought: request.query.bought === '1',
            justLoggedRepair: request.query.repairSaved === '1',
            justAddedCopy: request.query.copyAdded === '1',
            suggestion: context.suggestion,
            decided: decisionToastOf(request.query.decided),
          }}
        />,
      );
    },
  );

  // The garment page's condition control (garment-condition.tsx, an
  // AutosaveForm): posted on every change, answered with the form's status
  // line, never the chips (a plain post gets the page again). A garment
  // property: the owner and a MANAGE grantee.
  app.post(
    '/wardrobe/:id/condition',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: ConditionBody,
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
      const fields = readCondition(request.body);
      if (!(await setCondition(db, id, access.ownerId, fields))) {
        throw garmentNotFound();
      }
      logger.info(
        `Garment ${id} condition ${fields.condition}${fields.conditionNote ? ' (with a note)' : ''} set by user ${sessionUserId(request)}`,
      );
      if (!request.headers['hx-request']) {
        return reply.redirect(garmentUrl(id, viewOwner), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  app.get(
    '/wardrobe/:id/edit',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const garment = await requireGarment(
        db,
        request.params.id,
        access.ownerId,
      );
      return renderGarmentForm(reply, db, {
        mode: {
          kind: 'edit',
          garmentId: garment.id,
          wishlist: garment.status === 'wishlist',
        },
        suggestionsFrom: access.ownerId,
        viewOwner,
        values: storedFormValues(garment, { owner: access.isOwner }),
        repairs: repairPanel(
          garment,
          access.isOwner,
          todayIn(config.timeZone, new Date()),
        ),
      });
    },
  );

  // Every field is posted: the stored garment becomes what the form says
  // (a cleared field is null). A malformed or refused form writes nothing.
  // A save is the update alone (a garment gone is its 404); only a refused
  // form reads the garment, for the form again (#161).
  app.post(
    '/wardrobe/:id',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentBody,
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
      // A MANAGE grantee's post leaves the owner-only fields as stored.
      const form = readGarmentForm(
        request.body,
        formAudience({ kind: 'edit' }, viewOwner),
      );
      if (!form.ok) {
        const stored = await requireGarment(db, id, access.ownerId);
        return refuseForm(reply, {
          mode: {
            kind: 'edit',
            garmentId: id,
            wishlist: stored.status === 'wishlist',
          },
          suggestionsFrom: access.ownerId,
          viewOwner,
          values: form.values,
          errors: form.errors,
          repairs: repairPanel(
            stored,
            access.isOwner,
            todayIn(config.timeZone, new Date()),
          ),
        });
      }
      if (!(await updateGarmentFields(db, id, access.ownerId, form.fields))) {
        throw garmentNotFound();
      }
      logger.info(`Garment ${id} updated by user ${sessionUserId(request)}`);
      return reply.redirect(garmentUrl(id, viewOwner), 302);
    },
  );

  // The clone form, prefilled from the source; it posts to the route below.
  // Suggestions come from the requester's own wardrobe, where it will land.
  // A shared source's owner-only fields are not copied (FormAudience): the
  // clone starts at its role's wash limit.
  app.get(
    '/wardrobe/:id/clone',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'view',
      );
      const source = await requireGarment(
        db,
        request.params.id,
        access.ownerId,
      );
      const values = storedFormValues(source, { owner: access.isOwner });
      return renderGarmentForm(reply, db, {
        mode: {
          kind: 'clone',
          garmentId: source.id,
          wishlist: source.status === 'wishlist',
        },
        suggestionsFrom: sessionUserId(request),
        viewOwner,
        values: {
          ...values,
          name: source.name ? t('CLONE_NAME', { name: source.name }) : '',
        },
      });
    },
  );

  app.post(
    '/wardrobe/:id/clone',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentBody,
      },
    },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'view',
      );
      const source = await requireGarment(
        db,
        request.params.id,
        access.ownerId,
      );
      const mode = {
        kind: 'clone',
        garmentId: source.id,
        wishlist: source.status === 'wishlist',
      } as const;
      // The clone is the requester's own garment, whoever owns the source.
      const form = readGarmentForm(request.body, formAudience(mode, viewOwner));
      if (!form.ok) {
        return refuseForm(reply, {
          mode,
          suggestionsFrom: userId,
          viewOwner,
          values: form.values,
          errors: form.errors,
          lookalikesDismissed: readIdList(request.body.lookalikesDismissed),
        });
      }
      const id = await cloneGarment(deps, source, userId, form.fields);
      logger.info(`Garment ${id} cloned from ${source.id} by user ${userId}`);
      return reply.redirect(garmentUrl(id, undefined), 302);
    },
  );

  /**
   * Archive and Restore (htmx hx-post): owner only, even for a MANAGE
   * grantee. Each names its move, so a page that showed another status
   * (another phone, a stale tab) gets a 409 instead of the opposite move
   * the old archive toggle made. Through setGarmentStatus, the one writer.
   */
  async function changeStatus(
    request: FastifyRequest,
    reply: FastifyReply,
    target: { id: number; ownerId: number | '' | undefined },
    event: 'archive' | 'restore',
  ): Promise<FastifyReply> {
    const { access, viewOwner } = await authorizeGarmentWardrobe(
      db,
      request,
      target.ownerId,
      'own',
    );
    const { id } = target;
    const outcome = await setGarmentStatus(db, id, access.ownerId, { event });
    if (!outcome.ok) {
      if (outcome.reason === 'not-found') throw garmentNotFound();
      logger.info(`Garment ${id} ${event} refused: it is ${outcome.status}`);
      throw new HttpError(409, STATUS_REFUSED[event]);
    }
    logger.info(
      `Garment ${id} ${event}d (${outcome.from} -> ${outcome.to}) by user ${access.ownerId}`,
    );
    return navigateTo(reply, wardrobeUrl(viewOwner));
  }

  app.post(
    '/wardrobe/:id/archive',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    (request, reply) =>
      changeStatus(
        request,
        reply,
        { id: request.params.id, ownerId: request.query.ownerId },
        'archive',
      ),
  );

  app.post(
    '/wardrobe/:id/restore',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    (request, reply) =>
      changeStatus(
        request,
        reply,
        { id: request.params.id, ownerId: request.query.ownerId },
        'restore',
      ),
  );

  // htmx (hx-delete): owner only. The photo's bytes go after the rows commit.
  // The delete answers the status it had: no read before it (#161).
  app.delete(
    '/wardrobe/:id',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'own',
      );
      const { id } = request.params;
      const deleted = await removeGarment(deps, id, access.ownerId);
      if (!deleted.ok) {
        if (deleted.reason === 'not-found') throw garmentNotFound();
        logger.info(
          `Garment ${id} delete refused for user ${access.ownerId}: a suggestion, set aside, never deleted`,
        );
        throw new HttpError(409, t('wishlist.SUGGESTION_NOT_DELETED'));
      }
      const { status } = deleted;
      logger.info(
        `Garment ${id} (${status}) deleted by user ${access.ownerId}`,
      );
      // A wishlist item's delete is "not buying it": back to the wishlist.
      return navigateTo(
        reply,
        status === 'wishlist' ? WISHLIST_PATH : '/wardrobe',
      );
    },
  );

  done();
};
