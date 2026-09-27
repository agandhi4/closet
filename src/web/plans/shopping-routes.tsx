import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { viewContext } from '../view-context';
import { garmentUrl, WISHLIST_PATH } from '../wardrobe/urls';
import { GarmentParams } from '../wardrobe/validation';
import {
  garmentRef,
  type GarmentRef,
  wishlistItems,
} from '../wishlist/queries';
import {
  candidaciesOf,
  candidatesOfItems,
  changeCandidates,
  MAX_CANDIDATES_PER_ITEM,
  TooManyCandidates,
} from './candidates';
import { GarmentPlanItemsPage, ItemCandidatesPage } from './candidates-page';
import { planComparison } from './compare';
import { ComparePage } from './compare-page';
import { allPlanGaps } from './gaps';
import { findActivePlan, findPlan } from './queries';
import { requirePlanItem } from './require';
import { planShoppingList } from './shopping';
import { ShoppingPage } from './shopping-page';
import { COMPARE_PATH, PLANS_PATH, planUrl, SHOPPING_PATH } from './urls';
import { ItemParams, planNotFound } from './validation';

// Navigation state, but ids: not one is a 400, one that is not the owner's
// plan a 404 (it names a thing that does not exist for them).
const ShoppingQuery = Type.Object({ plan: Type.Optional(RowId) });
const CompareQuery = Type.Object({
  a: Type.Optional(RowId),
  b: Type.Optional(RowId),
});

// Where a candidates page goes back to (safeReturnTo'd: same-site paths only).
const RETURN_TO_MAX = 500;
const CandidatesQuery = Type.Object({
  returnTo: Type.Optional(Type.String({ maxLength: RETURN_TO_MAX })),
});

// The pickers post what is ticked and what they showed (the capsule
// picker's rule: only shown-and-unticked pairings leave).
const PICKED_MAX = 500;
const Picked = Type.Optional(Type.Array(RowId, { maxItems: PICKED_MAX }));
const CandidatesBody = Type.Object({
  garmentIds: Picked,
  shown: Picked,
  returnTo: Type.Optional(Type.String({ maxLength: RETURN_TO_MAX })),
});
const PlanItemsBody = Type.Object({ itemIds: Picked, shown: Picked });

const GARMENT_NOT_FOUND = 'Garment not found';

/**
 * A picker's save: the change, or the cap's refusal (TooManyCandidates) in
 * words for the form to come back with. Any other error is the error page's.
 */
async function refusedAsForm<T>(
  change: () => Promise<T>,
): Promise<T | { refused: string }> {
  try {
    return await change();
  } catch (error) {
    if (error instanceof TooManyCandidates) return { refused: error.message };
    throw error;
  }
}

/** Ticked and shown as the writer's add and remove. */
function picked(checked: number[] = [], shown: number[] = []) {
  return {
    checked,
    unchecked: shown.filter((id) => !checked.includes(id)),
  };
}

/**
 * The shopping loop (#34, slice 34b; plan section 15): the shopping list,
 * a plan item's candidate products and a wishlist item's plan items (both
 * sides of plan_item_candidate), and comparing two plans. "Bought it"
 * against an item is the wishlist's route with the plan part added
 * (src/web/wishlist/routes.tsx, src/web/plans/purchase.ts). All of it is
 * the signed-in owner's own, like plans: no route takes `?ownerId=`,
 * another user's plan, item or garment is a 404 like an unknown id.
 */
export const shoppingRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  /** The requester's own wishlist item `id`: a 404 unless it is theirs. */
  async function requireOwnGarment(
    userId: number,
    id: number,
  ): Promise<GarmentRef> {
    const garment = await garmentRef(db, id, userId);
    if (!garment) throw new HttpError(404, GARMENT_NOT_FOUND);
    return garment;
  }

  // The active plan's list, or another plan's with ?plan=.
  app.get(
    SHOPPING_PATH,
    { schema: { querystring: ShoppingQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const planId = request.query.plan;
      const plan =
        planId === undefined
          ? await findActivePlan(db, userId)
          : await findPlan(db, planId, userId);
      if (planId !== undefined && !plan) throw planNotFound();
      const list = plan && (await planShoppingList(db, plan, userId));
      return renderPage(
        reply,
        <ShoppingPage ctx={viewContext(reply)} model={{ plan, list }} />,
      );
    },
  );

  // A = ?a or the active plan (the list's first), B = ?b or the next one.
  app.get(
    COMPARE_PATH,
    { schema: { querystring: CompareQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const all = await allPlanGaps(db, userId);
      const pick = (id: number) => {
        const gaps = all.find((g) => g.plan.id === id);
        if (!gaps) throw planNotFound();
        return gaps;
      };
      const { a: aId, b: bId } = request.query;
      const a = aId === undefined ? all[0] : pick(aId);
      const b = bId === undefined ? all.find((gaps) => gaps !== a) : pick(bId);
      return renderPage(
        reply,
        <ComparePage
          ctx={viewContext(reply)}
          model={{
            plans: all.map((gaps) => gaps.plan),
            pair:
              a && b
                ? {
                    a: a.plan,
                    b: b.plan,
                    comparison: planComparison(a, b),
                  }
                : undefined,
          }}
        />,
      );
    },
  );

  // ---- A plan item's candidates -------------------------------------------

  /**
   * A plan item's candidates page: as stored, or (a refused save) with what
   * was ticked and why, 400.
   */
  async function renderItemCandidates(
    reply: FastifyReply,
    userId: number,
    { plan, item }: Awaited<ReturnType<typeof requirePlanItem>>,
    returnTo: string | undefined,
    refused?: { chosen: number[]; error: string },
  ) {
    const [wishlist, candidates] = await Promise.all([
      wishlistItems(db, userId),
      refused ? undefined : candidatesOfItems(db, userId, [item.id]),
    ]);
    const chosen =
      refused?.chosen ??
      (candidates?.get(item.id) ?? []).map((c) => c.garmentId);
    return renderPage(
      reply,
      <ItemCandidatesPage
        ctx={viewContext(reply)}
        model={{
          plan,
          item,
          wishlist,
          chosen: new Set(chosen),
          returnTo: returnTo
            ? safeReturnTo(returnTo, planUrl(plan.id))
            : undefined,
          error: refused?.error,
        }}
      />,
      { status: refused ? 400 : 200 },
    );
  }

  app.get(
    `${PLANS_PATH}/:id/items/:itemId/candidates`,
    { schema: { params: ItemParams, querystring: CandidatesQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const found = await requirePlanItem(
        db,
        userId,
        request.params.id,
        request.params.itemId,
      );
      return renderItemCandidates(reply, userId, found, request.query.returnTo);
    },
  );

  app.post(
    `${PLANS_PATH}/:id/items/:itemId/candidates`,
    { schema: { params: ItemParams, body: CandidatesBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const found = await requirePlanItem(
        db,
        userId,
        request.params.id,
        request.params.itemId,
      );
      const { plan, item } = found;
      const { checked, unchecked } = picked(
        request.body.garmentIds,
        request.body.shown,
      );
      const changed = await refusedAsForm(() =>
        changeCandidates(db, userId, {
          add: { itemIds: [item.id], garmentIds: checked },
          remove: { itemIds: [item.id], garmentIds: unchecked },
        }),
      );
      if ('refused' in changed) {
        logger.info(
          `Plan item ${item.id} of plan ${plan.id}: candidates refused for user ${userId}, past ${MAX_CANDIDATES_PER_ITEM}`,
        );
        return renderItemCandidates(
          reply,
          userId,
          found,
          request.body.returnTo,
          { chosen: checked, error: changed.refused },
        );
      }
      const { added, removed } = changed;
      logger.info(
        `Plan item ${item.id} of plan ${plan.id}: ${added} candidate(s) added, ${removed} removed by user ${userId}`,
      );
      return reply.redirect(
        safeReturnTo(request.body.returnTo, `${planUrl(plan.id)}?saved=1`),
        303,
      );
    },
  );

  // ---- A wishlist item's plan items ---------------------------------------

  /**
   * A wishlist item's plan items page: as stored, or (a refused save) with
   * what was ticked and why, 400.
   */
  async function renderGarmentPlanItems(
    reply: FastifyReply,
    userId: number,
    garment: GarmentRef,
    refused?: { chosen: number[]; error: string },
  ) {
    const [plans, candidacies] = await Promise.all([
      allPlanGaps(db, userId),
      refused ? [] : candidaciesOf(db, userId, [garment.id]),
    ]);
    const chosen = refused?.chosen ?? candidacies.map((c) => c.itemId);
    return renderPage(
      reply,
      <GarmentPlanItemsPage
        ctx={viewContext(reply)}
        model={{
          garment,
          plans,
          chosen: new Set(chosen),
          error: refused?.error,
        }}
      />,
      { status: refused ? 400 : 200 },
    );
  }

  // An item no longer on the wishlist (bought on another phone, a stale
  // link) sends the person to its page, as "Bought it" does.
  app.get(
    '/wardrobe/:id/plan-items',
    { schema: { params: GarmentParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const garment = await requireOwnGarment(userId, request.params.id);
      if (garment.status !== 'wishlist') {
        return reply.redirect(garmentUrl(garment.id, undefined), 302);
      }
      return renderGarmentPlanItems(reply, userId, garment);
    },
  );

  app.post(
    '/wardrobe/:id/plan-items',
    { schema: { params: GarmentParams, body: PlanItemsBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const garment = await requireOwnGarment(userId, request.params.id);
      if (garment.status !== 'wishlist') {
        throw new HttpError(409, t('wishlist.NOT_ON_WISHLIST'));
      }
      const { checked, unchecked } = picked(
        request.body.itemIds,
        request.body.shown,
      );
      const changed = await refusedAsForm(() =>
        changeCandidates(db, userId, {
          add: { itemIds: checked, garmentIds: [garment.id] },
          remove: { itemIds: unchecked, garmentIds: [garment.id] },
        }),
      );
      if ('refused' in changed) {
        logger.info(
          `Garment ${garment.id}: plan items refused for user ${userId}, an item past ${MAX_CANDIDATES_PER_ITEM} candidates`,
        );
        return renderGarmentPlanItems(reply, userId, garment, {
          chosen: checked,
          error: changed.refused,
        });
      }
      const { added, removed } = changed;
      logger.info(
        `Garment ${garment.id} a candidate for ${added} more plan item(s), ${removed} fewer, by user ${userId}`,
      );
      return reply.redirect(WISHLIST_PATH, 303);
    },
  );

  done();
};
