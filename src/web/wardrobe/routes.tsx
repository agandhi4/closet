import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { recordCutoutEvent } from '../../cutout/queries';
import {
  type CapsuleRef,
  capsuleNames,
  capsulesOfGarment,
  memberIds,
} from '../capsules/queries';
import { capsuleNotFound } from '../capsules/validation';
import {
  findType,
  FORMALITIES,
  GARMENT_COLORS,
  MATERIALS,
  WARMTHS,
} from '../../wardrobe/properties';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import {
  navigateTo,
  renderFragment,
  renderPage,
  wantsFragment,
} from '../render';
import {
  type AuthorizedWardrobe,
  authorizeWardrobe,
  sharedWardrobesOf,
  type WardrobeNeed,
} from '../sharing/access';
import { viewContext } from '../view-context';
import { type GoesWithCloset, goesWithCloset } from '../gallery/ideas';
import { avoidedWith } from '../gallery/queries';
import { GARMENT_OUTFITS_SHOWN } from '../outfits/garment-outfits';
import { outfitsWithGarment } from '../outfits/queries';
import { countNeedingWash, wearSummary } from '../wears/queries';
import { normalizeCategory, normalizeSize } from './garment';
import {
  GarmentPage,
  type GarmentPageModel,
  GarmentPhotoView,
} from './garment-page';
import { keptLinkPhoto } from './link-import/photo-choice';
import { PropertiesFragment } from './property-fields';
import {
  bulkSetProperty,
  countToTag,
  filterOptions,
  findGarment,
  type GarmentDetail,
  gridCount,
  type GridFilters,
  gridPage,
  nextToTag,
  setCondition,
  updateGarmentFields,
  updateGarmentProperties,
} from './queries';
import { garmentRef, replacementsOf } from '../wishlist/queries';
import {
  destinationValues,
  postedDestination,
  resolveDestination,
} from './destination';
import { type GarmentFormRequest, renderGarmentForm } from './render-form';
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
import { garmentUrl, wardrobeUrl, WISHLIST_PATH } from './urls';
import {
  BulkBody,
  ConditionBody,
  DestinationQuery,
  formValues,
  GarmentBody,
  type GarmentField,
  GarmentPageQuery,
  GarmentParams,
  GridQuery,
  OwnerQuery,
  pick,
  PropertiesFragmentQuery,
  propertyFormValues,
  readBulkChange,
  readCondition,
  readGarmentForm,
  readTags,
  storedFormValues,
  TagBody,
  TagQuery,
  TilesQuery,
  withPresets,
} from './validation';
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
  createGarmentWithLinkPhoto,
  removeGarment,
  replacePhoto,
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
  return authorizeWardrobe(
    db,
    sessionUserId(request),
    ownerId,
    need,
    GARMENT_NOT_FOUND,
  );
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
): Pick<GridSearch, 'type' | 'warmth' | 'formality' | 'material'> {
  return {
    type: findType(category, query.type)?.value ?? '',
    warmth: query.warmth ?? '',
    formality: query.formality ?? '',
    material: query.material ?? '',
  };
}

function gridFilters(search: GridSearch): GridFilters {
  return {
    keyword: search.keyword || undefined,
    category: search.category || undefined,
    color: pick(GARMENT_COLORS, search.color) ?? undefined,
    size: search.size || undefined,
    type: search.type || undefined,
    warmth: pick(WARMTHS, search.warmth) ?? undefined,
    formality: pick(FORMALITIES, search.formality) ?? undefined,
    material: pick(MATERIALS, search.material) ?? undefined,
    scope: scopeOf(search),
    capsule: search.capsule ? Number(search.capsule) : undefined,
    needsWash: search.needsWash === 'true',
    attention: search.attention === 'true',
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

  /** The capsule picker for `capsule`: its members start checked. */
  async function picker(capsule: CapsuleRef, ownerId: number) {
    return {
      capsuleId: capsule.id,
      name: capsule.name,
      members: await memberIds(db, capsule.id, ownerId),
    };
  }

  /** The tagging card for the garment after `before` (the first without). */
  async function tagCardModel(
    ownerId: number,
    viewOwner: number | undefined,
    before: number | undefined,
  ): Promise<TagCardModel> {
    const [garment, left] = await Promise.all([
      nextToTag(db, ownerId, before),
      countToTag(db, ownerId),
    ]);
    return { garment, left, viewOwner };
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
      const [
        page,
        count,
        filterValues,
        sharedWardrobes,
        toTag,
        toWash,
        capsules,
      ] = await Promise.all([
        gridPage(db, access.ownerId, filters, { ownerView: access.isOwner }),
        gridCount(db, access.ownerId, filters),
        filterOptions(db, access.ownerId),
        sharedWardrobesOf(db, userId),
        // The "need details" prompt is only for someone who can tag.
        access.canManage ? countToTag(db, access.ownerId) : 0,
        // The laundry prompt reads wears: the owner's alone.
        access.isOwner ? countNeedingWash(db, access.ownerId) : 0,
        capsuleNames(db, access.ownerId),
      ]);
      if (filters.capsule) listedCapsule(capsules, filters.capsule);
      const picking =
        pick === undefined
          ? undefined
          : await picker(listedCapsule(capsules, pick), access.ownerId);
      const model = {
        search,
        page,
        count,
        options: filterValues,
        sharedWardrobes,
        viewOwner,
        canEdit: access.canManage,
        ownerView: access.isOwner,
        toTag,
        toWash,
        // Only someone who may write can select for a bulk edit or pick.
        selecting:
          access.canManage &&
          (request.query.select === '1' || picking !== undefined),
        picking,
        capsules,
        bulkResult: bulkResult(request.query),
      };
      if (wantsFragment(request, reply)) {
        return renderFragment(reply, <WardrobeFragment model={model} />);
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
      const [page, picking] = await Promise.all([
        gridPage(db, access.ownerId, gridFilters(search), {
          before: request.query.before,
          ownerView: access.isOwner,
        }),
        pick === undefined
          ? undefined
          : memberIds(db, pick, access.ownerId).then((members) => ({
              capsuleId: pick,
              members,
            })),
      ]);
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
  // prefilled from the garment it replaces with `&replaces=`, a candidate
  // for a plan item of the owner's with `&planItem=`).
  app.get(
    '/wardrobe/new',
    { schema: { querystring: DestinationQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { destination, replaced, candidateFor } = await resolveDestination(
        db,
        request.query,
        access,
      );
      return renderGarmentForm(reply, db, {
        mode: { kind: 'new', destination },
        suggestionsFrom: access.ownerId,
        viewOwner,
        values: destinationValues(destination, replaced),
        candidateFor,
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

  // A new garment. A form prefilled from a link also posts `linkPhoto`, the
  // photo fetched with it (stored, no row yet), which is claimed here with
  // the garment (createGarmentWithLinkPhoto); a refused form keeps it.
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
      // A plan item's "Add a candidate" (34b) is checked before anything is
      // read or stored, and linked in the garment's transaction.
      const { destination, candidateFor, linkCandidate } =
        await postedDestination(db, request.body, access);
      const status = destination.to;
      const again = {
        mode: { kind: 'new', destination },
        suggestionsFrom: access.ownerId,
        viewOwner,
        link: linkPhoto ? keptLinkPhoto(linkPhoto) : undefined,
        candidateFor,
      } as const;
      const form = readGarmentForm(request.body);
      if (!form.ok) {
        return refuseForm(reply, {
          ...again,
          values: form.values,
          errors: form.errors,
        });
      }
      const id = linkPhoto
        ? await createGarmentWithLinkPhoto(
            deps,
            access.ownerId,
            sessionUserId(request),
            form.fields,
            linkPhoto,
            status,
            linkCandidate,
          )
        : await createGarment(
            deps,
            access.ownerId,
            form.fields,
            status,
            linkCandidate,
          );
      if (id === undefined) {
        return refuseForm(reply, {
          ...again,
          link: keptLinkPhoto(undefined),
          values: formValues(request.body),
          errors: { linkPhoto: [t('linkImport.PHOTO_GONE')] },
        });
      }
      logger.info(
        `Garment ${id} created (${status}) by user ${sessionUserId(request)} in wardrobe ${access.ownerId}${
          form.fields.replacesGarmentId
            ? `, asked to replace garment ${form.fields.replacesGarmentId}`
            : ''
        }${candidateFor ? `, a candidate for plan item ${candidateFor.id}` : ''}`,
      );
      return reply.redirect(garmentUrl(id, viewOwner, '', { created: 1 }), 302);
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
    '/wardrobe/tag',
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
      const [saved, left] = await Promise.all([
        requireGarment(options, id, access.ownerId),
        countToTag(db, access.ownerId),
      ]);
      return renderFragment(reply, <TagSaved garment={saved} left={left} />);
    },
  );

  /**
   * A wishlist item's "Goes with my closet" (#18b) for its page: the
   * owner's alone (it reads their closet and clashes), so nothing for a
   * grantee or for a garment not on the wishlist.
   */
  async function judgeWishlistItem(
    garment: GarmentDetail,
    access: { isOwner: boolean; ownerId: number },
    today: IsoDate,
  ): Promise<GoesWithCloset | undefined> {
    if (garment.status !== 'wishlist' || !access.isOwner) return undefined;
    const started = performance.now();
    const judged = await goesWithCloset(db, access.ownerId, garment.id, today);
    if (judged) {
      logger.debug(
        `Goes with my closet for user ${access.ownerId}: wishlist item ${garment.id} makes ${judged.outfits}${judged.capped ? '+' : ''} outfit(s), ${judged.nearDuplicates.length} near-duplicate(s), in ${Math.round(performance.now() - started)} ms`,
      );
    }
    return judged;
  }

  /**
   * The garment page's reads of the owner's own records: its wears and
   * washes, the outfits that hold it ("In N outfits", #84) and the garments
   * the gallery never pairs it with. Like outfits and the calendar, never
   * read for a grantee (the page renders none of them), nor for a wishlist
   * item, which is not in the closet.
   */
  async function ownerRecords(
    garment: GarmentDetail,
    access: { isOwner: boolean; ownerId: number },
    today: IsoDate,
  ): Promise<
    Pick<GarmentPageModel, 'wear' | 'outfits'> & {
      avoided: GarmentPageModel['styling']['avoided'];
    }
  > {
    if (garment.status === 'wishlist' || !access.isOwner) {
      return { wear: undefined, outfits: undefined, avoided: [] };
    }
    const [summary, outfits, avoided] = await Promise.all([
      wearSummary(db, garment.id, today),
      outfitsWithGarment(db, access.ownerId, garment.id, GARMENT_OUTFITS_SHOWN),
      avoidedWith(db, access.ownerId, garment.id),
    ]);
    return { wear: { summary, today }, outfits, avoided };
  }

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
      // What a garment page shows depends on where the garment is: a
      // wishlist item has no wears, washes or capsules (closet reads), and
      // says what it replaces; a closet garment lists the wishlist items
      // that would replace it.
      const [capsules, replaces, replacedBy, own, goesWith] = await Promise.all(
        [
          garment.status === 'wishlist'
            ? []
            : capsulesOfGarment(db, access.ownerId, id),
          garment.replacesGarmentId === null
            ? undefined
            : garmentRef(db, garment.replacesGarmentId, access.ownerId),
          garment.status === 'closet'
            ? replacementsOf(db, id, access.ownerId)
            : [],
          ownerRecords(garment, access, today),
          judgeWishlistItem(garment, access, today),
        ],
      );
      return renderPage(
        reply,
        <GarmentPage
          ctx={viewContext(reply)}
          model={{
            garment,
            capsules,
            viewOwner,
            wear: own.wear,
            replaces,
            replacedBy,
            // "Style this" is anyone's who sees a closet garment: Styling
            // browses a shared wardrobe (#42) and saves only one's own.
            styling: {
              canStyle: garment.status === 'closet',
              avoided: own.avoided,
            },
            goesWith,
            outfits: own.outfits,
            canEdit: access.canManage,
            canDelete: access.isOwner,
            justCreated: request.query.created === '1',
            justSavedPhoto: request.query.photoSaved === '1',
            justBought: request.query.bought === '1',
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
        values: storedFormValues(garment),
      });
    },
  );

  // Every field is posted: the stored garment becomes what the form says
  // (a cleared field is null). A malformed or refused form writes nothing.
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
      const stored = await requireGarment(options, id, access.ownerId);
      const form = readGarmentForm(request.body);
      if (!form.ok) {
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
      const values = storedFormValues(source);
      return renderGarmentForm(reply, db, {
        mode: { kind: 'clone', garmentId: source.id },
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
      const form = readGarmentForm(request.body);
      if (!form.ok) {
        return refuseForm(reply, {
          mode: { kind: 'clone', garmentId: source.id },
          suggestionsFrom: userId,
          viewOwner,
          values: form.values,
          errors: form.errors,
        });
      }
      const id = await cloneGarment(deps, source, userId, form.fields);
      logger.info(`Garment ${id} cloned from ${source.id} by user ${userId}`);
      return reply.redirect(garmentUrl(id, undefined), 302);
    },
  );

  // htmx (hx-post, multipart): the photo; its cutout is queued. The garment
  // is checked before the body is read, so a refused upload stores nothing.
  // Two files: pages cached before server-side removal also send the
  // browser's cutout (nobgPhoto), which storeUploadParts drains and ignores;
  // a third file would be a 413.
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
      return reply
        .header('HX-Redirect', garmentUrl(id, viewOwner, '', { photoSaved: 1 }))
        .status(200)
        .send();
    },
  );

  // The mask editor's save (public/js/mask-editor.js): the edited cutout
  // replaces the stored one; the answer is the photo's new version,
  // so the page can point at the new immutable URL.
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
      const version = await options.photos.saveEditedCutout(
        part.file,
        garment.photo.fileName,
      );
      logger.info(`Garment ${id} cutout replaced, photo version ${version}`);
      return reply.send({ version });
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
      const garment = await requireGarment(options, id, access.ownerId);
      if (!(await removeGarment(deps, id, access.ownerId))) throw notFound();
      logger.info(
        `Garment ${id} (${garment.status}) deleted by user ${access.ownerId}`,
      );
      // A wishlist item's delete is "not buying it": back to the wishlist.
      return navigateTo(
        reply,
        garment.status === 'wishlist' ? WISHLIST_PATH : '/wardrobe',
      );
    },
  );

  done();
};
