import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isBuiltInCategory } from '../../wardrobe/properties';
import { sessionUserId } from '../auth/require-session';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { navigateTo, renderPage } from '../render';
import { authorizeWardrobe, sharedWardrobesOf } from '../sharing/access';
import { viewContext } from '../view-context';
import { candidatesOfPlan, changeCandidates } from './candidates';
import { itemsFromCloset } from './derive';
import { allPlanGaps, planGaps } from './gaps';
import { ItemFormPage, type ItemFormModel } from './item-form-page';
import { PlansPage } from './list-page';
import { PlanFormPage, type PlanFormModel } from './plan-form-page';
import { PlanPage } from './plan-page';
import {
  acceptItem,
  closetCategories,
  closetPieces,
  createPlan,
  deleteItem,
  deletePlan,
  findStyleProfile,
  freePlanName,
  insertItems,
  itemFields,
  itemsOf,
  type PlanDetail,
  saveStyleProfile,
  setActivePlan,
  updateItem,
  updatePlan,
} from './queries';
import { findWeatherSettings } from '../weather/queries';
import { weeklyRhythm } from '../../wardrobe/week';
import { findWeekTemplate } from '../week-plan/template';
import { StyleProfilePage } from './style-page';
import { requirePlan as requireOwnPlan, requirePlanItem } from './require';
import { PLANS_PATH, planUrl, STYLE_PROFILE_PATH } from './urls';
import {
  BLANK_ITEM_VALUES,
  EMPTY_STYLE_PROFILE,
  FromWardrobeBody,
  ItemParams,
  itemNotFound,
  PlanBody,
  type PlanForm,
  planNameTaken,
  planNotFound,
  PlanItemBody,
  type PlanItemForm,
  PlanPageQuery,
  PlanParams,
  readPlanForm,
  readPlanItemForm,
  readStyleProfileForm,
  storedItemValues,
  StyleProfileBody,
  styleProfilePost,
  StyleProfileQuery,
} from './validation';

/**
 * Wardrobe plans and the style profile (#34, slice 34a; plan section 15).
 * Both are the signed-in owner's own, like outfits (owner decision on the
 * issue: private): no route takes `?ownerId=`, and another user's plan or
 * item is a 404 like an unknown id. The one route that reads another
 * wardrobe is "start from a wardrobe", which authorizes a view of it
 * exactly as a page's `?ownerId=` would (authorizeWardrobe) and writes the
 * plan into the requester's own.
 *
 * Forms are native posts (PostForm: a refusal re-renders 400, which htmx
 * would not swap); deletes are htmx (hx-delete, navigateTo).
 */
export const planRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  /**
   * The home city for the style page, read-only: the weather's (#14,
   * user_weather), never a second copy. Undefined with WEATHER_ENABLED off,
   * when there is no home to speak of.
   */
  async function homeCity(
    userId: number,
  ): Promise<{ name: string | null } | undefined> {
    if (!options.weather) return undefined;
    const settings = await findWeatherSettings(db, userId);
    return { name: settings.home?.name ?? null };
  }

  function requirePlan(
    request: FastifyRequest,
    id: number,
  ): Promise<PlanDetail> {
    return requireOwnPlan(db, sessionUserId(request), id);
  }

  function renderPlanForm(
    reply: FastifyReply,
    model: PlanFormModel,
    status = 200,
  ): Promise<FastifyReply> {
    return renderPage(
      reply,
      <PlanFormPage ctx={viewContext(reply)} model={model} />,
      { status },
    );
  }

  function refusePlanForm(
    reply: FastifyReply,
    refused: PlanForm & { ok: false },
    planId?: number,
  ): Promise<FastifyReply> {
    logger.warn(
      `Plan form refused (${planId === undefined ? 'new' : `plan ${planId}`}): ${refused.errors.name?.join(' ')}`,
    );
    return renderPlanForm(
      reply,
      {
        planId,
        values: {
          name: refused.values.name,
          notes: refused.values.notes ?? '',
        },
        errors: refused.errors,
      },
      400,
    );
  }

  async function renderItemForm(
    reply: FastifyReply,
    plan: PlanDetail,
    model: Omit<ItemFormModel, 'planId' | 'planName' | 'customCategories'>,
    ownerId: number,
    status = 200,
  ): Promise<FastifyReply> {
    const categories = await closetCategories(db, ownerId);
    return renderPage(
      reply,
      <ItemFormPage
        ctx={viewContext(reply)}
        model={{
          ...model,
          planId: plan.id,
          planName: plan.name,
          customCategories: categories.filter((c) => !isBuiltInCategory(c)),
        }}
      />,
      { status },
    );
  }

  function refuseItemForm(
    reply: FastifyReply,
    plan: PlanDetail,
    refused: PlanItemForm & { ok: false },
    ownerId: number,
    item?: { id: number; proposed: boolean },
  ): Promise<FastifyReply> {
    logger.warn(
      `Plan item form refused (plan ${plan.id}, ${item ? `item ${item.id}` : 'new'}): ${Object.keys(refused.errors).join(', ')}`,
    );
    return renderItemForm(
      reply,
      plan,
      {
        itemId: item?.id,
        proposed: item?.proposed,
        values: refused.values,
        errors: refused.errors,
      },
      ownerId,
      400,
    );
  }

  // ---- Plans ------------------------------------------------------------------

  app.get(PLANS_PATH, async (request, reply) => {
    const userId = sessionUserId(request);
    const [plans, shared] = await Promise.all([
      allPlanGaps(db, userId),
      sharedWardrobesOf(db, userId),
    ]);
    return renderPage(
      reply,
      <PlansPage
        ctx={viewContext(reply)}
        model={{
          plans,
          sources: [
            ...shared.map((wardrobe) => ({
              ownerId: wardrobe.grantorId,
              name: wardrobe.grantorName,
            })),
            { ownerId: userId, name: null },
          ],
        }}
      />,
    );
  });

  app.get(`${PLANS_PATH}/new`, async (_request, reply) =>
    renderPlanForm(reply, { values: { name: '', notes: '' } }),
  );

  app.post(
    PLANS_PATH,
    { schema: { body: PlanBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const form = readPlanForm(request.body);
      if (!form.ok) return refusePlanForm(reply, form);
      const id = await createPlan(db, userId, form.fields);
      if (id === 'name-taken') {
        return refusePlanForm(reply, planNameTaken(request.body));
      }
      logger.info(`Plan ${id} created by user ${userId}`);
      return reply.redirect(`${planUrl(id)}?created=1`, 303);
    },
  );

  // "Start from a wardrobe": the closet of a wardrobe the requester can view
  // (their own, or one shared with them: Theo's), grouped into plan items
  // (itemsFromCloset), as a new plan of the requester's own. A wardrobe
  // they cannot view is a 404 like an unknown one.
  app.post(
    `${PLANS_PATH}/from-wardrobe`,
    { schema: { body: FromWardrobeBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { access } = await authorizeWardrobe(
        db,
        userId,
        request.body.ownerId,
        'view',
        'Wardrobe not found',
      );
      const sourceName = access.isOwner
        ? null
        : ((await sharedWardrobesOf(db, userId)).find(
            (shared) => shared.grantorId === access.ownerId,
          )?.grantorName ?? null);
      const closet = await closetPieces(db, access.ownerId);
      const items = itemsFromCloset(closet, sourceName);
      const name = await freePlanName(db, userId, (n) => {
        const base =
          sourceName === null
            ? t('plans.FROM_MY_CLOSET_NAME')
            : t('plans.FROM_WARDROBE_NAME', { name: sourceName });
        return n === 1 ? base : `${base} ${n}`;
      });
      const id = await createPlan(db, userId, { name, notes: null }, items);
      if (id === 'name-taken') {
        // Taken between freePlanName and the insert: another tab, the same tap.
        throw new Error(`Plan name "${name}" taken while starting a plan`);
      }
      logger.info(
        `Plan ${id} started by user ${userId} from wardrobe ${access.ownerId}: ${items.length} items from ${closet.length} garments`,
      );
      return reply.redirect(`${planUrl(id)}?created=1`, 303);
    },
  );

  app.get(
    `${PLANS_PATH}/:id`,
    { schema: { params: PlanParams, querystring: PlanPageQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const plan = await requirePlan(request, request.params.id);
      const { created, saved } = request.query;
      const [gaps, candidates] = await Promise.all([
        planGaps(db, plan, userId),
        candidatesOfPlan(db, userId, plan.id),
      ]);
      return renderPage(
        reply,
        <PlanPage
          ctx={viewContext(reply)}
          model={{
            gaps,
            candidates,
            toast:
              created === '1' ? 'created' : saved === '1' ? 'saved' : undefined,
          }}
        />,
      );
    },
  );

  app.get(
    `${PLANS_PATH}/:id/edit`,
    { schema: { params: PlanParams } },
    async (request, reply) => {
      const plan = await requirePlan(request, request.params.id);
      return renderPlanForm(reply, {
        planId: plan.id,
        values: { name: plan.name, notes: plan.notes ?? '' },
      });
    },
  );

  app.post(
    `${PLANS_PATH}/:id`,
    { schema: { params: PlanParams, body: PlanBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      await requirePlan(request, id);
      const form = readPlanForm(request.body);
      if (!form.ok) return refusePlanForm(reply, form, id);
      const saved = await updatePlan(db, id, userId, form.fields);
      if (saved === 'not-found') throw planNotFound();
      if (saved === 'name-taken') {
        return refusePlanForm(reply, planNameTaken(request.body), id);
      }
      logger.info(`Plan ${id} updated by user ${userId}`);
      return reply.redirect(`${planUrl(id)}?saved=1`, 303);
    },
  );

  // htmx (hx-delete, hx-confirm). The garments are untouched; with the
  // active plan gone there is none until the owner picks one.
  app.delete(
    `${PLANS_PATH}/:id`,
    { schema: { params: PlanParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      if (!(await deletePlan(db, id, userId))) throw planNotFound();
      logger.info(`Plan ${id} deleted by user ${userId}`);
      return navigateTo(reply, PLANS_PATH);
    },
  );

  app.post(
    `${PLANS_PATH}/:id/activate`,
    { schema: { params: PlanParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      if (!(await setActivePlan(db, id, userId))) throw planNotFound();
      logger.info(`Plan ${id} made active by user ${userId}`);
      return reply.redirect(`${planUrl(id)}?saved=1`, 303);
    },
  );

  // A copy to iterate on ("NYC minimal (copy)"): every item, proposals
  // included, as they are, with their candidate products (34b). Active only
  // when no plan is (createPlan's rule): otherwise the original stays the
  // plan until the owner says.
  app.post(
    `${PLANS_PATH}/:id/duplicate`,
    { schema: { params: PlanParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const plan = await requirePlan(request, request.params.id);
      const [items, candidates] = await Promise.all([
        itemsOf(db, [plan.id]),
        candidatesOfPlan(db, userId, plan.id),
      ]);
      const name = await freePlanName(db, userId, (n) =>
        n === 1
          ? t('plans.COPY_NAME', { name: plan.name })
          : t('plans.COPY_NAME_N', { name: plan.name, n }),
      );
      const id = await db.transaction(async (tx) => {
        const created = await createPlan(tx, userId, {
          name,
          notes: plan.notes,
        });
        if (created === 'name-taken') {
          throw new Error(`Plan name "${name}" taken while duplicating`);
        }
        for (const proposed of [false, true]) {
          const originals = items.filter((item) => item.proposed === proposed);
          const copies = await insertItems(
            tx,
            created,
            originals.map(itemFields),
            { proposed },
          );
          for (const [index, original] of originals.entries()) {
            const garmentIds = (candidates.get(original.id) ?? []).map(
              (candidate) => candidate.garmentId,
            );
            if (garmentIds.length === 0) continue;
            await changeCandidates(tx, userId, {
              add: { itemIds: [copies[index]], garmentIds },
            });
          }
        }
        return created;
      });
      logger.info(
        `Plan ${plan.id} duplicated by user ${userId} as plan ${id} (${items.length} items)`,
      );
      return reply.redirect(`${planUrl(id)}?created=1`, 303);
    },
  );

  // ---- Items ------------------------------------------------------------------

  app.get(
    `${PLANS_PATH}/:id/items/new`,
    { schema: { params: PlanParams } },
    async (request, reply) => {
      const plan = await requirePlan(request, request.params.id);
      return renderItemForm(
        reply,
        plan,
        { values: BLANK_ITEM_VALUES },
        sessionUserId(request),
      );
    },
  );

  app.post(
    `${PLANS_PATH}/:id/items`,
    { schema: { params: PlanParams, body: PlanItemBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const plan = await requirePlan(request, request.params.id);
      const form = readPlanItemForm(request.body);
      if (!form.ok) return refuseItemForm(reply, plan, form, userId);
      const [itemId] = await insertItems(db, plan.id, [form.fields], {
        proposed: false,
      });
      logger.info(
        `Plan item ${itemId} added to plan ${plan.id} by user ${userId}`,
      );
      return reply.redirect(`${planUrl(plan.id)}?saved=1`, 303);
    },
  );

  async function requireItem(
    request: FastifyRequest,
    planId: number,
    itemId: number,
  ) {
    const userId = sessionUserId(request);
    return {
      ...(await requirePlanItem(db, userId, planId, itemId)),
      userId,
    };
  }

  app.get(
    `${PLANS_PATH}/:id/items/:itemId/edit`,
    { schema: { params: ItemParams } },
    async (request, reply) => {
      const { plan, item, userId } = await requireItem(
        request,
        request.params.id,
        request.params.itemId,
      );
      return renderItemForm(
        reply,
        plan,
        {
          itemId: item.id,
          proposed: item.proposed,
          values: storedItemValues(item),
        },
        userId,
      );
    },
  );

  // The owner's save rewrites the item whole and accepts it if their agent
  // proposed it: reviewing a proposal in the form is accepting it.
  app.post(
    `${PLANS_PATH}/:id/items/:itemId`,
    { schema: { params: ItemParams, body: PlanItemBody } },
    async (request, reply) => {
      const { plan, item, userId } = await requireItem(
        request,
        request.params.id,
        request.params.itemId,
      );
      const form = readPlanItemForm(request.body);
      if (!form.ok) return refuseItemForm(reply, plan, form, userId, item);
      const saved = await updateItem(
        db,
        item.id,
        plan.id,
        userId,
        form.fields,
        {
          proposed: false,
        },
      );
      if (!saved) throw itemNotFound();
      logger.info(
        `Plan item ${item.id} of plan ${plan.id} updated by user ${userId}${item.proposed ? ' (proposal accepted)' : ''}`,
      );
      return reply.redirect(`${planUrl(plan.id)}?saved=1`, 303);
    },
  );

  app.post(
    `${PLANS_PATH}/:id/items/:itemId/accept`,
    { schema: { params: ItemParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id, itemId } = request.params;
      await requirePlan(request, id);
      if (!(await acceptItem(db, itemId, id, userId))) throw itemNotFound();
      logger.info(
        `Plan item ${itemId} of plan ${id} accepted by user ${userId}`,
      );
      return reply.redirect(`${planUrl(id)}?saved=1`, 303);
    },
  );

  // htmx: the edit form's Delete and a proposal's Dismiss; back to the plan.
  app.delete(
    `${PLANS_PATH}/:id/items/:itemId`,
    { schema: { params: ItemParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id, itemId } = request.params;
      await requirePlan(request, id);
      if (!(await deleteItem(db, itemId, id, userId))) throw itemNotFound();
      logger.info(
        `Plan item ${itemId} of plan ${id} deleted by user ${userId}`,
      );
      return navigateTo(reply, planUrl(id));
    },
  );

  // ---- The style profile ------------------------------------------------------

  app.get(
    STYLE_PROFILE_PATH,
    { schema: { querystring: StyleProfileQuery } },
    async (request, reply) => {
      const profile =
        (await findStyleProfile(db, sessionUserId(request))) ??
        EMPTY_STYLE_PROFILE;
      return renderPage(
        reply,
        <StyleProfilePage
          ctx={viewContext(reply)}
          model={{
            values: styleProfilePost(profile),
            rhythm: weeklyRhythm(
              await findWeekTemplate(db, sessionUserId(request)),
            ),
            home: await homeCity(sessionUserId(request)),
            saved: request.query.saved === '1',
          }}
        />,
      );
    },
  );

  app.post(
    STYLE_PROFILE_PATH,
    { schema: { body: StyleProfileBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const fields = readStyleProfileForm(request.body);
      await saveStyleProfile(db, userId, fields);
      logger.info(
        `Style profile saved by user ${userId}: ${fields.styles?.length ?? 0} styles, ${fields.palette?.length ?? 0} colours`,
      );
      return reply.redirect(`${STYLE_PROFILE_PATH}?saved=1`, 303);
    },
  );

  done();
};
