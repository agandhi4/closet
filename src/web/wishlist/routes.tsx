import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import type { FieldErrors } from '../auth/validation';
import { type IsoDate, parseIsoDate, todayIn } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import {
  type AuthorizedWardrobe,
  authorizeWardrobe,
  type WardrobeNeed,
} from '../sharing/access';
import { viewContext } from '../view-context';
import { findGarment, type GarmentDetail } from '../wardrobe/queries';
import { buyGarment, type Purchase } from '../wardrobe/status';
import { garmentUrl } from '../wardrobe/urls';
import {
  GarmentParams,
  OwnerQuery,
  PRICE_INPUT_MAX,
  readPrice,
} from '../wardrobe/validation';
import { type BoughtField, type BoughtModel, BoughtPage } from './bought-page';
import { garmentRef, type GarmentRef, wishlistItems } from './queries';
import { WishlistPage } from './wishlist-page';

const GARMENT_NOT_FOUND = 'Garment not found';

// "Bought it": the day and the price paid as typed (checked by readPurchase,
// re-rendered with messages), and the archive of the replaced garment,
// which only the owner may ask for.
const BoughtBody = Type.Object({
  acquiredOn: Type.Optional(Type.String({ maxLength: 32 })),
  price: Type.Optional(Type.String({ maxLength: PRICE_INPUT_MAX })),
  archiveReplaced: Type.Optional(Type.Literal('1')),
});
type BoughtBody = Static<typeof BoughtBody>;

/** The purchase as stored (a blank field is null), or what is wrong with it. */
function readPurchase(
  body: BoughtBody,
):
  | { ok: true; purchase: Purchase }
  | { ok: false; errors: FieldErrors<BoughtField> } {
  const typedDay = body.acquiredOn?.trim();
  const acquiredOn: IsoDate | null | undefined = typedDay
    ? parseIsoDate(typedDay)
    : null;
  const price = readPrice(body.price);
  const errors: FieldErrors<BoughtField> = {
    ...(acquiredOn === undefined && {
      acquiredOn: [t('validation.INVALID_DATE')],
    }),
    ...('error' in price && { price: [price.error] }),
  };
  if (acquiredOn === undefined || 'error' in price)
    return { ok: false, errors };
  return { ok: true, purchase: { acquiredOn, price: price.price } };
}

/**
 * The Wishlist tab and "Bought it" (#18, plan section 11). Wishlist items
 * are the wardrobe's garments with status 'wishlist', so they are shared
 * like the rest of it (owner decision, #18): a VIEW grantee reads the
 * grantor's wishlist (a gift list; the owner reading a sibling's), a MANAGE
 * grantee also adds, edits and buys, and only the owner archives the
 * garment a purchase replaces or deletes an item. Adding and editing are
 * the garment form's (src/web/wardrobe, `?to=wishlist`).
 */
export const wishlistRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger, config } = options;

  function resolve(
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

  async function requireGarment(
    id: number,
    ownerId: number,
  ): Promise<GarmentDetail> {
    const garment = await findGarment(db, id, ownerId);
    if (!garment) throw new HttpError(404, GARMENT_NOT_FOUND);
    return garment;
  }

  /** The replaced garment to offer for the archive: still in the closet, and the requester its owner. */
  async function archivable(
    garment: GarmentDetail,
    { access }: AuthorizedWardrobe,
  ): Promise<GarmentRef | undefined> {
    if (!access.isOwner || garment.replacesGarmentId === null) return undefined;
    const replaced = await garmentRef(
      db,
      garment.replacesGarmentId,
      access.ownerId,
    );
    return replaced?.status === 'closet' ? replaced : undefined;
  }

  function renderBought(
    reply: FastifyReply,
    model: BoughtModel,
    status = 200,
  ): Promise<FastifyReply> {
    return renderPage(
      reply,
      <BoughtPage ctx={viewContext(reply)} model={model} />,
      { status },
    );
  }

  app.get(
    '/wardrobe/wishlist',
    { schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        request,
        request.query.ownerId,
        'view',
      );
      const items = await wishlistItems(db, access.ownerId);
      return renderPage(
        reply,
        <WishlistPage
          ctx={viewContext(reply)}
          model={{ items, viewOwner, canEdit: access.canManage }}
        />,
      );
    },
  );

  // The form. A garment that is no longer on the wishlist (bought on
  // another phone, a stale link) sends the person to its page.
  app.get(
    '/wardrobe/:id/bought',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const authorized = await resolve(
        request,
        request.query.ownerId,
        'manage',
      );
      const { access, viewOwner } = authorized;
      const garment = await requireGarment(request.params.id, access.ownerId);
      if (garment.status !== 'wishlist') {
        return reply.redirect(garmentUrl(garment.id, viewOwner), 302);
      }
      return renderBought(reply, {
        garment,
        viewOwner,
        values: {
          acquiredOn: todayIn(config.timeZone, new Date()),
          price: garment.price ?? '',
        },
        archivable: await archivable(garment, authorized),
      });
    },
  );

  // Into the closet (buyGarment: setGarmentStatus's buy, and the replaced
  // garment's archive when asked, in one transaction), then its page with
  // a toast. A grantee asking for the archive is a 403 before anything is
  // written; an item already bought is a 409.
  app.post(
    '/wardrobe/:id/bought',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: BoughtBody,
      },
    },
    async (request, reply) => {
      const authorized = await resolve(
        request,
        request.query.ownerId,
        'manage',
      );
      const { access, viewOwner } = authorized;
      const archiveReplaced = request.body.archiveReplaced === '1';
      if (archiveReplaced && !access.isOwner) throw new HttpError(403);
      const garment = await requireGarment(request.params.id, access.ownerId);
      const read = readPurchase(request.body);
      if (!read.ok) {
        logger.warn(
          `Bought it refused for garment ${garment.id}: ${Object.keys(read.errors).join(', ')}`,
        );
        return renderBought(
          reply,
          {
            garment,
            viewOwner,
            values: {
              acquiredOn: request.body.acquiredOn ?? '',
              price: request.body.price ?? '',
            },
            archivable: await archivable(garment, authorized),
            errors: read.errors,
          },
          400,
        );
      }
      const outcome = await buyGarment(db, garment.id, access.ownerId, {
        ...read.purchase,
        archiveReplaced,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'not-found') {
          throw new HttpError(404, GARMENT_NOT_FOUND);
        }
        logger.info(
          `Bought it ignored for garment ${garment.id}: it is ${outcome.status}`,
        );
        throw new HttpError(409, t('wishlist.NOT_ON_WISHLIST'));
      }
      logger.info(
        `Garment ${garment.id} bought (wishlist -> closet) by user ${sessionUserId(request)} in wardrobe ${access.ownerId}${
          outcome.archivedReplaced === null
            ? ''
            : `; garment ${outcome.archivedReplaced} it replaces archived`
        }`,
      );
      return reply.redirect(
        garmentUrl(garment.id, viewOwner, '', { bought: 1 }),
        303,
      );
    },
  );

  done();
};
