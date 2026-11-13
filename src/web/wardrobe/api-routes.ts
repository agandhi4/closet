import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { CARE_WASH } from '../../wardrobe/care';
import {
  FORMALITIES,
  GARMENT_COLORS,
  MATERIALS,
  WARMTHS,
} from '../../wardrobe/properties';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import {
  idCursor,
  ListCursor,
  ListLimit,
  ListOf,
  literals,
  readIdCursor,
} from '../api/resource';
import { GarmentParams, ROW_ID_MAX, RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { garmentGuard, searchGarments } from './garment-access';
import { garmentContext } from './garment-context';
import { CATEGORY_MAX, NAME_MAX, SIZE_MAX } from './garment-input';
import {
  Garment,
  GarmentListItem,
  toGarmentListItem,
  toGarmentResource,
} from './garment-resource';
import { searchFilters } from './garment-search';
import { GRID_PAGE_SIZE } from './grid-page-size';

/** `?ownerId=`: a wardrobe shared with the caller; absent, their own. */
const OwnerId = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: ROW_ID_MAX,
    description:
      "A wardrobe shared with you (its owner's id); absent, your own",
  }),
);

const flag = (description: string) =>
  Type.Boolean({ default: false, description });

/**
 * GET /garments' query: the grid's filters as search_garments names them
 * (GarmentSearchInput), the wardrobe, and the page.
 */
const GarmentListQuery = Type.Object({
  ownerId: OwnerId,
  keyword: Type.Optional(
    Type.String({
      maxLength: NAME_MAX,
      description: 'Matches the name, brand and notes',
    }),
  ),
  category: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  type: Type.Optional(
    Type.String({
      maxLength: 40,
      description: 'A type of `category`, which it needs',
    }),
  ),
  color: Type.Optional(literals(GARMENT_COLORS)),
  size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
  warmth: Type.Optional(literals(WARMTHS)),
  formality: Type.Optional(literals(FORMALITIES)),
  material: Type.Optional(literals(MATERIALS)),
  wash: Type.Optional(literals(CARE_WASH)),
  capsuleId: Type.Optional(RowId),
  includeArchived: flag('Also garments no longer in the closet'),
  needsWash: flag(
    'Only garments with a copy that needs a wash: your own wardrobe only',
  ),
  needsAttention: flag('Only garments that need repair or replacing soon'),
  needsTagging: flag(
    'Only closet garments still missing their type, warmth or formality',
  ),
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(GRID_PAGE_SIZE),
});

const GarmentList = ListOf(GarmentListItem, {
  title: 'GarmentList',
  description: 'A page of the wardrobe, newest first',
  extra: {
    /** The grid's "N results": every garment the filters match. */
    total: Type.Integer({ minimum: 0 }),
  },
});

const GarmentQuery = Type.Object({ ownerId: OwnerId });

/**
 * The wardrobe's API routes (#192a; plan section 6), registered by
 * apiPlugin under /api/v1, each calling what the grid and the garment page
 * call. Reads only: the writes are #192b, the photo's #192c.
 *  - GET /garments: the wardrobe's closet, filtered and paged as the grid
 *    (searchGarments, MCP's search_garments): one statement for the page
 *    and one for the count, after the token's.
 *  - GET /garments/{id}: the garment in full, as its page reads it
 *    (requireGarment, garmentContext): the owner's own records only for
 *    the owner.
 * A grantee's `?ownerId=` share rides in the token's read (#170), so
 * neither costs more than its page twin.
 */
export const wardrobeApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config },
  done,
) => {
  const authorize = garmentGuard(db);

  app.get(
    '/garments',
    {
      schema: {
        operationId: 'listGarments',
        tags: ['garments'],
        summary: "A wardrobe's garments, filtered as the grid filters them",
        description:
          'The closet (with `includeArchived` the archive too; never the wishlist), newest first. A type without its category is a 400; `needsWash` on a shared wardrobe is a 403; a capsule outside the wardrobe a 404.',
        querystring: GarmentListQuery,
        response: apiResponses({ 200: GarmentList }),
      },
    },
    async (request) => {
      const { ownerId, cursor, limit, ...search } = request.query;
      const { total, garments, next } = await searchGarments(
        db,
        actorOf(request),
        {
          ownerId,
          filters: searchFilters(search),
          before: cursor === undefined ? undefined : readIdCursor(cursor),
          limit,
        },
      );
      return {
        data: garments.map(toGarmentListItem),
        pagination: {
          ...(next !== null && { nextCursor: idCursor(next) }),
          limit,
        },
        total,
      };
    },
  );

  app.get(
    '/garments/:id',
    {
      schema: {
        operationId: 'getGarment',
        tags: ['garments'],
        summary: 'One garment in full, with its photo',
        description:
          'Any garment of a wardrobe you can see, a wishlist item included. A garment outside it is a 404 like an unknown id. `care` and `repairs` only on your own wardrobe.',
        params: GarmentParams,
        querystring: GarmentQuery,
        response: apiResponses({ 200: Garment }),
      },
    },
    async (request) => {
      const { access, garment } = await authorize.garment(request, 'view');
      const context = await garmentContext(
        db,
        garment,
        access,
        todayIn(config.timeZone, new Date()),
      );
      return toGarmentResource(garment, context);
    },
  );

  done();
};
