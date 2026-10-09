import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { recordCutoutEvent } from '../../cutout/queries';
import type { CapsuleRef } from '../capsules/queries';
import { capsuleNotFound } from '../capsules/validation';
import {
  findType,
  FORMALITIES,
  GARMENT_COLORS,
  MATERIALS,
  WARMTHS,
} from '../../wardrobe/properties';
import { CARE_WASH } from '../../wardrobe/care';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { todayIn } from '../../calendar-date';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { imageUrl } from '../files/image-url';
import {
  type Draft,
  draftsHeld,
  MAX_DRAFTS_PER_USER,
  pendingPhotoOf,
} from '../files/pending-photos';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import {
  navigateTo,
  renderFragment,
  renderPage,
  wantsFragment,
} from '../render';
import { GarmentParams, OwnerQuery, pick } from '../schemas';
import {
  type AuthorizedWardrobe,
  authorizeWardrobe,
  type WardrobeAccess,
  type WardrobeNeed,
} from '../sharing/access';
import { viewContext } from '../view-context';
import { type GoesWithCloset, judgeGoesWithCloset } from '../gallery/ideas';
import { decisionToastOf } from '../wishlist/suggestion-parts';
import type { GoesWithInputs } from '../gallery/queries';
import { normalizeCategory, normalizeSize } from './garment';
import { garmentContext } from './garment-context';
import { GarmentPage, GarmentPhotoView } from './garment-page';
import { nextDraft } from './draft-queue';
import { pendingPhotoView } from './link-import/photo-choice';
import { PropertiesFragment } from './property-fields';
import { repairPanel } from './repairs';
import {
  bulkSetProperty,
  findGarment,
  type GarmentDetail,
  type GridFilters,
  gridPage,
  nextToTag,
  setCondition,
  taggedGarment,
  updateGarmentFields,
  updateGarmentProperties,
} from './queries';
import {
  destinationValues,
  postedDestination,
  resolveDestination,
} from './destination';
import { formAudience } from './garment-form';
import { type GridContextPart, gridContext } from './grid-context';
import {
  draftNotFound,
  type GarmentFormRequest,
  renderGarmentForm,
} from './render-form';
import {
  type GarmentScope,
  setGarmentStatus,
  type StatusChange,
} from './status';
import {
  TAG_CARD_ID,
  TagCard,
  type TagCardModel,
  TagPage,
  TagSaved,
} from './tag-page';
import {
  batchDoneUrl,
  DRAFT_DISCARD_PATH,
  draftUrl,
  garmentUrl,
  PHOTO_ADD_PATH,
  readIdList,
  TAG_PATH,
  wardrobeUrl,
  WISHLIST_PATH,
} from './urls';
import {
  BulkBody,
  GridQuery,
  readBulkChange,
  readTags,
  TagBody,
  TagQuery,
  TilesQuery,
} from './grid-schemas';
import {
  ConditionBody,
  DiscardDraftBody,
  GarmentPageQuery,
  NewGarmentQuery,
  PropertiesFragmentQuery,
  RotateBody,
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
import {
  GarmentTiles,
  type GridSearch,
  searchParams,
  WardrobeFragment,
  WardrobePage,
} from './wardrobe-page';
import {
  cloneGarment,
  createGarment,
  createGarmentWithPendingPhoto,
  discardPendingPhoto,
  removeGarment,
  replacePhoto,
  rotateGarmentPhoto,
  stagePhotoUploads,
  type WardrobeDeps,
} from './writes';

/**
 * Who may do what (authorizeWardrobe, src/web/sharing/access.ts): a
 * wardrobe the requester cannot see is a 404 like an unknown id, and so is
 * a garment outside the wardrobe the request addresses; one they can see
 * but not change is a 403. Reads need a view, writes a MANAGE share (or
 * ownership), archive and delete ownership, and a clone only a view: it
 * lands in the requester's own wardrobe and only reads the source.
 */
function resolve(
  { db }: WebOptions,
  request: FastifyRequest,
  ownerId: number | '' | undefined,
  need: WardrobeNeed,
): Promise<AuthorizedWardrobe> {
  return authorizeWardrobe(db, request, ownerId, need, GARMENT_NOT_FOUND);
}

const GARMENT_NOT_FOUND = 'Garment not found';

function notFound(): HttpError {
  return new HttpError(404, GARMENT_NOT_FOUND);
}

async function requireGarment(
  options: WebOptions,
  id: number,
  ownerId: number,
): Promise<GarmentDetail> {
  const garment = await findGarment(options.db, id, ownerId);
  if (!garment) throw notFound();
  return garment;
}

/** The filters as the page echoes them. */
function gridSearch(query: GridQuery, isOwner: boolean): GridSearch {
  const category = query.category ? normalizeCategory(query.category) : '';
  return {
    keyword: query.keyword?.trim() ?? '',
    category,
    color: query.color ?? '',
    size: (query.size && normalizeSize(query.size)) || '',
    ...propertySearch(query, category),
    archived: query.archived === 'true' ? 'true' : '',
    capsule: query.capsule ? String(query.capsule) : '',
    ...careSearch(query, isOwner),
  };
}

/**
 * The care filters. "Needs a wash" reads the owner's wears, so it is
 * dropped on a shared wardrobe (`isOwner` false), like a type without its
 * category: the grid shows unfiltered, and reveals nothing.
 */
function careSearch(
  query: GridQuery,
  isOwner: boolean,
): Pick<GridSearch, 'needsWash' | 'attention'> {
  return {
    needsWash: isOwner && query.needsWash === 'true' ? 'true' : '',
    attention: query.attention === 'true' ? 'true' : '',
  };
}

/** The property filters; a type only with its own category. */
function propertySearch(
  query: GridQuery,
  category: string,
): Pick<GridSearch, 'type' | 'warmth' | 'formality' | 'material' | 'wash'> {
  return {
    type: findType(category, query.type)?.value ?? '',
    warmth: query.warmth ?? '',
    formality: query.formality ?? '',
    material: query.material ?? '',
    wash: query.wash ?? '',
  };
}

function gridFilters(search: GridSearch): GridFilters {
  return {
    keyword: search.keyword || undefined,
    category: search.category || undefined,
    color: pick(GARMENT_COLORS, search.color) ?? undefined,
    size: search.size || undefined,
    ...propertyFilters(search),
    scope: scopeOf(search),
    capsule: search.capsule ? Number(search.capsule) : undefined,
    needsWash: search.needsWash === 'true',
    attention: search.attention === 'true',
  };
}

/** The property filters as the query layer takes them (propertySearch's). */
function propertyFilters(
  search: GridSearch,
): Pick<GridFilters, 'type' | 'warmth' | 'formality' | 'material' | 'wash'> {
  return {
    type: search.type || undefined,
    warmth: pick(WARMTHS, search.warmth) ?? undefined,
    formality: pick(FORMALITIES, search.formality) ?? undefined,
    material: pick(MATERIALS, search.material) ?? undefined,
    wash: pick(CARE_WASH, search.wash) ?? undefined,
  };
}

/** The grid's garments: the closet, or with "Show archived" the archive too. */
function scopeOf(search: GridSearch): GarmentScope {
  return search.archived === 'true' ? 'owned' : 'closet';
}

/** What POST /wardrobe/bulk's redirect reports, for its toast. */
function bulkResult(
  query: GridQuery,
): { updated: number; skipped: number } | undefined {
  return query.bulkUpdated === undefined
    ? undefined
    : { updated: query.bulkUpdated, skipped: query.bulkSkipped ?? 0 };
}

/** The capsule `id` names among the wardrobe's own, or a 404 like an unknown id. */
function listedCapsule(capsules: CapsuleRef[], id: number): CapsuleRef {
  const found = capsules.find((capsule) => capsule.id === id);
  if (!found) throw capsuleNotFound();
  return found;
}

/**
 * What GET /wardrobe's answer renders around its tiles (GridContext):
 * browsing, all of it the requester may see, the app bar's switcher only
 * on a full page (a fragment swaps #wardrobe-main and the ⋯ menu). Select
 * mode and the picker render none of it; they read the capsules only to
 * refuse another wardrobe's `?capsule=` or `?pick=` and to name the picker.
 */
function gridContextParts(answer: {
  access: WardrobeAccess;
  selecting: boolean;
  fragment: boolean;
  filters: GridFilters;
  pick: number | undefined;
}): Set<GridContextPart> {
  const { access, selecting, fragment, filters, pick } = answer;
  if (selecting) {
    const capsuleNamed = filters.capsule !== undefined || pick !== undefined;
    return new Set(capsuleNamed ? ['capsules'] : []);
  }
  const parts: GridContextPart[] = ['count', 'options', 'capsules'];
  // Tagging and drafts are for someone who can write; wears are the owner's.
  if (access.canManage) parts.push('toTag', 'drafts');
  if (access.isOwner) parts.push('toWash');
  if (!fragment) parts.push('sharedWardrobes');
  return new Set(parts);
}

/** Archive and Restore's 409 when the garment's status does not take the event. */
const STATUS_REFUSED: Record<Exclude<StatusChange['event'], 'buy'>, string> = {
  archive: 'Only a garment in the closet can be archived',
  restore: 'Only an archived garment can be restored',
};

/**
 * /wardrobe: the grid (with its fragment and its "load more" pages), the
 * garment page, the new/edit/clone forms and their posts, the photo upload,
 * the cutout's polling, retry and mask edit, archive and delete. Every route takes `?ownerId=` for a
 * shared wardrobe (resolve above). Adding from a link has its
 * own plugin (link-import/routes.tsx) that ends on this form.
 */
export const wardrobeRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
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

  /** The tagging card for the garment after `before` (the first without). */
  async function tagCardModel(
    ownerId: number,
    viewOwner: number | undefined,
    before: number | undefined,
  ): Promise<TagCardModel> {
    return { ...(await nextToTag(db, ownerId, before)), viewOwner };
  }

  /**
   * Where a batch's queue goes once its draft `photo` is saved as garment
   * `id` (#200): the next draft after it in picked order, wrapping round
   * (so one skipped earlier comes back once the rest are done), else
   * select mode with the batch checked. The claim answered the drafts
   * still waiting (takePendingPhoto), so this reads nothing.
   */
  function afterDraft(
    viewOwner: number | undefined,
    photo: string,
    draft: Draft,
    saved: readonly number[],
    id: number,
  ): string {
    logger.info(
      `Garment ${id} saved from draft ${photo} of batch ${draft.batchId.slice(0, 8)}`,
    );
    const next = nextDraft(draft.waiting, draft.position);
    const savedNow = [...saved, id];
    return next
      ? draftUrl(viewOwner, next, savedNow)
      : batchEnd(viewOwner, savedNow);
  }

  /** Where a batch's queue ends: select mode with what it saved checked. */
  function batchEnd(
    viewOwner: number | undefined,
    saved: readonly number[],
  ): string {
    logger.info(`Draft queue done: ${saved.length} garments saved`);
    return saved.length > 0
      ? batchDoneUrl(viewOwner, saved)
      : wardrobeUrl(viewOwner);
  }

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

  // Filtering and searching are navigation state: malformed values fall
  // back or are dropped, except a colour outside the built-in set (400,
  // GridQuery) and a capsule that is not the wardrobe's (404). An htmx
  // fragment request (the scope row, the filter modal) gets #wardrobe-main
  // and the ⋯ menu out of band; the first page only, always. `?pick=` (owner and MANAGE) is the
  // capsule picker: select mode with the capsule's members checked.
  app.get(
    '/wardrobe',
    { schema: { querystring: GridQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const search = gridSearch(request.query, access.isOwner);
      const filters = gridFilters(search);
      const pick = access.canManage ? request.query.pick : undefined;
      // Only someone who may write can select for a bulk edit or pick.
      const selecting =
        access.canManage &&
        (request.query.select === '1' || pick !== undefined);
      const fragment = wantsFragment(request, reply);
      // Two statements (and the session's): the page, and everything
      // around it that this answer renders (gridContextParts).
      const [page, context] = await Promise.all([
        gridPage(db, access.ownerId, filters, {
          ownerView: access.isOwner,
          pick,
        }),
        gridContext(
          db,
          { userId, ownerId: access.ownerId, filters },
          gridContextParts({ access, selecting, fragment, filters, pick }),
        ),
      ]);
      const { capsules } = context;
      if (filters.capsule) listedCapsule(capsules, filters.capsule);
      const picking =
        pick === undefined ? undefined : listedCapsule(capsules, pick);
      const model = {
        ...context,
        search,
        page,
        viewOwner,
        canEdit: access.canManage,
        ownerView: access.isOwner,
        selecting,
        picking: picking && { capsuleId: picking.id, name: picking.name },
        bulkResult: bulkResult(request.query),
        // A batch's end (#200): its garments start checked for "Set…".
        batchSaved: new Set(readIdList(request.query.checked)),
      };
      if (fragment) {
        return renderFragment(
          reply,
          <WardrobeFragment ctx={viewContext(reply)} model={model} />,
        );
      }
      return renderPage(
        reply,
        <WardrobePage ctx={viewContext(reply)} model={model} />,
      );
    },
  );

  // The grid's "load more" sentinel (hx-trigger="revealed"): the page after
  // `before`, with the same filters, and the next sentinel. Always a fragment.
  app.get(
    '/wardrobe/tiles',
    { schema: { querystring: TilesQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      // The capsule filter needs no lookup here: it matches nothing outside
      // the capsule's own wardrobe (inCapsule), and the page that started
      // the scroll already refused a foreign one. Neither does the picker:
      // a capsule of another wardrobe has no members here.
      const search = gridSearch(request.query, access.isOwner);
      const pick = access.canManage ? request.query.pick : undefined;
      const page = await gridPage(db, access.ownerId, gridFilters(search), {
        before: request.query.before,
        ownerView: access.isOwner,
        pick,
      });
      const picking = pick === undefined ? undefined : { capsuleId: pick };
      return renderFragment(
        reply,
        <GarmentTiles
          page={page}
          search={search}
          viewOwner={viewOwner}
          selecting={
            access.canManage &&
            (request.query.select === '1' || pick !== undefined)
          }
          picking={picking}
        />,
      );
    },
  );

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
      const { access, viewOwner } = await resolve(
        options,
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
      const { access, viewOwner } = await resolve(
        options,
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
      const { access, viewOwner } = await resolve(
        options,
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
        next ? draftUrl(viewOwner, next, saved) : batchEnd(viewOwner, saved),
        303,
      );
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
      const { access, viewOwner } = await resolve(
        options,
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
            afterDraft(viewOwner, linkPhoto, draft, saved, id),
            303,
          )
        : reply.redirect(garmentUrl(id, viewOwner, '', savedFlag), 302);
    },
  );

  // Select mode's "Set…": one property on every selected garment its role
  // allows (bulkSetProperty), then back to the grid with the same filters
  // (carried in the action's query) and a toast saying how many were set
  // and skipped. A native post (PostForm): htmx drops a 4xx, and the answer
  // is another page anyway.
  app.post(
    '/wardrobe/bulk',
    { schema: { querystring: GridQuery, body: BulkBody } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const ids = request.body.ids ?? [];
      const change = readBulkChange(request.body);
      const result =
        change && ids.length > 0
          ? await bulkSetProperty(db, access.ownerId, ids, change)
          : { updated: 0, skipped: 0 };
      logger.info(
        `Bulk ${request.body.property} by user ${sessionUserId(request)} in wardrobe ${access.ownerId}: ${result.updated} set, ${result.skipped} skipped, ${ids.length} selected`,
      );
      const search = gridSearch(request.query, access.isOwner);
      return reply.redirect(
        wardrobeUrl(viewOwner, {
          ...searchParams(search),
          bulkUpdated: result.updated,
          bulkSkipped: result.skipped,
        }),
        303,
      );
    },
  );

  // Tagging mode (src/web/wardrobe/tag-page.tsx): the next garment still
  // needing its type, warmth or formality, after `?before=`. A fragment
  // request gets the card alone: Next was a link here before it became the
  // card's submit button, and pages the installed app cached still ask.
  app.get(
    TAG_PATH,
    { schema: { querystring: TagQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const model = await tagCardModel(
        access.ownerId,
        viewOwner,
        request.query.before,
      );
      if (wantsFragment(request, reply)) {
        return renderFragment(reply, <TagCard model={model} />);
      }
      return renderPage(
        reply,
        <TagPage ctx={viewContext(reply)} model={model} />,
      );
    },
  );

  // The tagging card's AutosaveForm (tag-page.tsx): a tap saves the chips
  // and answers them as saved (a new type's presets filled where nothing was
  // set; readTags) with the count left; Next (`next=1`) saves the same way
  // and answers the card after this garment instead. A post that changes
  // nothing writes nothing: Next on a card left alone only moves on.
  app.post(
    '/wardrobe/:id/tag',
    {
      schema: { params: GarmentParams, querystring: OwnerQuery, body: TagBody },
    },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const { next, ...tags } = request.body;
      const garment = await requireGarment(options, id, access.ownerId);
      // Only what differs from the stored garment: the card posts its
      // checked chips every time, Next included.
      const changes = readTags(tags, garment);
      if (!changes) throw new HttpError(400, 'Not a type of this category');
      const changed = Object.keys(changes);
      if (changed.length > 0) {
        if (!(await updateGarmentProperties(db, id, access.ownerId, changes))) {
          throw notFound();
        }
        logger.info(
          `Garment ${id} tagged by user ${sessionUserId(request)}: ${changed.join(', ')}`,
        );
      }
      if (next) {
        logger.info(
          `Tagging: user ${sessionUserId(request)} moved on from garment ${id}`,
        );
        // The whole card, not the chips the form targets: the next garment's.
        reply.header('HX-Retarget', `#${TAG_CARD_ID}`);
        reply.header('HX-Reswap', 'outerHTML');
        return renderFragment(
          reply,
          <TagCard model={await tagCardModel(access.ownerId, viewOwner, id)} />,
        );
      }
      const saved = await taggedGarment(db, id, access.ownerId);
      if (!saved) throw notFound();
      return renderFragment(
        reply,
        <TagSaved garment={saved.garment} left={saved.left} />,
      );
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
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const { id } = request.params;
      const today = todayIn(config.timeZone, new Date());
      const garment = await requireGarment(options, id, access.ownerId);
      const context = await garmentContext(db, garment, access, today);
      const { own } = context;
      return renderPage(
        reply,
        <GarmentPage
          ctx={viewContext(reply)}
          model={{
            garment,
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
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const fields = readCondition(request.body);
      if (!(await setCondition(db, id, access.ownerId, fields))) {
        throw notFound();
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

  // The garment page's photo while its cutout is pending polls this
  // (hx-trigger every 2s) and swaps it in; the answer stops polling once
  // the cutout is ready or failed.
  app.get(
    '/wardrobe/:id/cutout',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const garment = await requireGarment(
        options,
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
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const garment = await requireGarment(options, id, access.ownerId);
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

  app.get(
    '/wardrobe/:id/edit',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const garment = await requireGarment(
        options,
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
      const { access, viewOwner } = await resolve(
        options,
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
        const stored = await requireGarment(options, id, access.ownerId);
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
        throw notFound();
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
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const source = await requireGarment(
        options,
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
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const source = await requireGarment(
        options,
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
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      await requireGarment(options, id, access.ownerId);
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
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const garment = await requireGarment(options, id, access.ownerId);
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
      const { access } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const garment = await requireGarment(options, id, access.ownerId);
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
    const { access, viewOwner } = await resolve(
      options,
      request,
      target.ownerId,
      'own',
    );
    const { id } = target;
    const outcome = await setGarmentStatus(db, id, access.ownerId, { event });
    if (!outcome.ok) {
      if (outcome.reason === 'not-found') throw notFound();
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
      const { access } = await resolve(
        options,
        request,
        request.query.ownerId,
        'own',
      );
      const { id } = request.params;
      const deleted = await removeGarment(deps, id, access.ownerId);
      if (!deleted.ok) {
        if (deleted.reason === 'not-found') throw notFound();
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
