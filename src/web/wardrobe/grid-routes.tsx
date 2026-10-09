import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
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
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage, wantsFragment } from '../render';
import type { WardrobeAccess } from '../sharing/access';
import { viewContext } from '../view-context';
import { normalizeCategory, normalizeSize } from './garment';
import {
  authorizeGarmentWardrobe,
  garmentNotFound,
  requireGarment,
} from './garment-access';
import {
  bulkSetProperty,
  type GridFilters,
  gridPage,
  nextToTag,
  taggedGarment,
  updateGarmentProperties,
} from './queries';
import { type GridContextPart, gridContext } from './grid-context';
import { type GarmentScope } from './status';
import {
  TAG_CARD_ID,
  TagCard,
  type TagCardModel,
  TagPage,
  TagSaved,
} from './tag-page';
import { TAG_PATH, wardrobeUrl, readIdList } from './urls';
import {
  GarmentTiles,
  type GridSearch,
  searchParams,
  WardrobeFragment,
  WardrobePage,
} from './wardrobe-page';
import {
  BulkBody,
  GridQuery,
  readBulkChange,
  readTags,
  TagBody,
  TagQuery,
  TilesQuery,
} from './grid-schemas';
import { GarmentParams, OwnerQuery, pick } from '../schemas';

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

/**
 * The grid and the modes that work on it: GET /wardrobe (with its fragment),
 * its "load more" tiles, select mode's bulk edit and tagging mode. Every
 * route takes `?ownerId=` for a shared wardrobe (authorizeGarmentWardrobe).
 */
export const gridRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  /** The tagging card for the garment after `before` (the first without). */
  async function tagCardModel(
    ownerId: number,
    viewOwner: number | undefined,
    before: number | undefined,
  ): Promise<TagCardModel> {
    return { ...(await nextToTag(db, ownerId, before)), viewOwner };
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
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
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
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
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

  // Select mode's "Set…": one property on every selected garment its role
  // allows (bulkSetProperty), then back to the grid with the same filters
  // (carried in the action's query) and a toast saying how many were set
  // and skipped. A native post (PostForm): htmx drops a 4xx, and the answer
  // is another page anyway.
  app.post(
    '/wardrobe/bulk',
    { schema: { querystring: GridQuery, body: BulkBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
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
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
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
      const { access, viewOwner } = await authorizeGarmentWardrobe(
        db,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const { next, ...tags } = request.body;
      const garment = await requireGarment(db, id, access.ownerId);
      // Only what differs from the stored garment: the card posts its
      // checked chips every time, Next included.
      const changes = readTags(tags, garment);
      if (!changes) throw new HttpError(400, 'Not a type of this category');
      const changed = Object.keys(changes);
      if (changed.length > 0) {
        if (!(await updateGarmentProperties(db, id, access.ownerId, changes))) {
          throw garmentNotFound();
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
      if (!saved) throw garmentNotFound();
      return renderFragment(
        reply,
        <TagSaved garment={saved.garment} left={saved.left} />,
      );
    },
  );

  done();
};
