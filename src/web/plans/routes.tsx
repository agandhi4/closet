import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { categorySuggestions } from '../wardrobe/garment';
import { ownerTransaction } from '../auth/queries';
import { selectScalars } from '../../db/select-scalars';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { navigateTo, renderPage } from '../render';
import { authorizeWardrobe, sharedWardrobesOf } from '../sharing/access';
import { viewContext } from '../view-context';
import { ALREADY_SAVED_FLAG } from '../gallery/urls';
import { outfitUrl } from '../outfits/urls';
import {
  type CandidateAdd,
  candidatesOfPlan,
  changeCandidates,
} from './candidates';
import { itemsFromCloset } from './derive';
import { planCovers } from './covers';
import { allPlanGaps, planGaps } from './gaps';
import { ItemFormPage, type ItemFormModel } from './item-form-page';
import { PlansPage } from './list-page';
import { PlanFormPage, type PlanFormModel } from './plan-form-page';
import { PlanPage, planView } from './plan-page';
import type { PlanItemReviewEvent } from '../../wardrobe/plan-review';
import type { LookReactionEvent } from '../../wardrobe/look-reaction';
import { ChangeItemPage, ChangeLookPage } from './change-page';
import {
  copyLooks,
  groupLooks,
  lookNotFound,
  looksOfPlan,
  reactToLooks,
  saveLookAsOutfit,
} from './looks';
import { copyRejections } from './rejections';
import {
  applyReview,
  type LookChoice,
  planReview,
  readReview,
  reviewPostOf,
  type ReviewChoice,
  type ReviewError,
} from './review';
import { ReviewPage } from './review-page';
import {
  addItems,
  closetCategories,
  closetPieces,
  createGeneratedPlan,
  copyItems,
  createPlan,
  deleteItems,
  deletePlan,
  findPlan,
  itemsOf,
  type PlanDetail,
  type PlanItemRow,
  reviewItems,
  saveStyleProfile,
  setActivePlan,
  styleProfileSql,
  updateItem,
  updatePlan,
} from './queries';
import { homeNameSql } from '../weather/queries';
import { weeklyRhythm } from '../../wardrobe/week';
import { inTemplateOrder, weekTemplateSql } from '../week-plan/template';
import { StyleProfilePage } from './style-page';
import { requirePlan as requireOwnPlan, requirePlanItem } from './require';
import {
  NEW_PLAN_PATH,
  PLANS_PATH,
  planUrl,
  planViewUrl,
  STYLE_PROFILE_PATH,
} from './urls';
import {
  BLANK_ITEM_VALUES,
  ChangeBody,
  DeclineBody,
  EMPTY_STYLE_PROFILE,
  FromWardrobeBody,
  ItemParams,
  itemNotFound,
  LookParams,
  PlanBody,
  type PlanForm,
  planNameTaken,
  planNotFound,
  PlanItemBody,
  type PlanItemForm,
  PlanPageQuery,
  PlanParams,
  readPlanForm,
  ReviewBody,
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
    model: Omit<ItemFormModel, 'planId' | 'planName' | 'categories'>,
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
          categories: categorySuggestions(categories),
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
    item?: PlanItemRow,
  ): Promise<FastifyReply> {
    logger.warn(
      `Plan item form refused (plan ${plan.id}, ${item ? `item ${item.id}` : 'new'}): ${Object.keys(refused.errors).join(', ')}`,
    );
    return renderItemForm(
      reply,
      plan,
      {
        itemId: item?.id,
        review: item?.review,
        ownerNote: item?.ownerNote,
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
    const [plans, covers, shared] = await Promise.all([
      allPlanGaps(db, userId),
      planCovers(db, userId),
      sharedWardrobesOf(db, userId),
    ]);
    return renderPage(
      reply,
      <PlansPage
        ctx={viewContext(reply)}
        model={{
          plans,
          covers,
          sources: [
            ...shared.map((wardrobe) => ({
              ownerId: wardrobe.grantorId,
              name: wardrobe.grantorName,
            })),
            { ownerId: userId, name: null },
          ],
          sharedWardrobes: shared,
        }}
      />,
    );
  });

  app.get(NEW_PLAN_PATH, async (_request, reply) =>
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
        request,
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
      const numbered = (name: string, n: number) =>
        n === 1 ? name : `${name} ${n}`;
      // A long name is cut in the wardrobe's name, not the words around it.
      const { id } = await createGeneratedPlan(
        db,
        userId,
        sourceName === null
          ? { base: t('plans.FROM_MY_CLOSET_NAME'), nameFor: numbered }
          : {
              base: sourceName,
              nameFor: (base, n) =>
                numbered(t('plans.FROM_WARDROBE_NAME', { name: base }), n),
            },
        null,
        items,
      );
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
      const { created, saved, reviewed, removed, view } = request.query;
      const [gaps, candidates, looks] = await Promise.all([
        planGaps(db, plan, userId),
        candidatesOfPlan(db, userId, plan.id),
        looksOfPlan(db, userId, plan.id),
      ]);
      return renderPage(
        reply,
        <PlanPage
          ctx={viewContext(reply)}
          model={{
            gaps,
            candidates,
            looks: groupLooks(looks),
            view: planView(view),
            toast:
              created === '1'
                ? 'created'
                : saved === '1'
                  ? 'saved'
                  : reviewed === '1'
                    ? 'reviewed'
                    : undefined,
            removed: reviewed === '1' ? removed : undefined,
          }}
        />,
      );
    },
  );

  // ---- The review (#271) -------------------------------------------------------

  /**
   * The review page: as it stands (200), as it stands now after a post the
   * page could not have sent (`changed`, 400), or as posted with each
   * strip's error (`refused`, 400).
   */
  async function renderReview(
    reply: FastifyReply,
    plan: PlanDetail,
    userId: number,
    state: {
      changed?: boolean;
      refused?: {
        posted: Map<number, ReviewChoice>;
        errors: Map<number, ReviewError>;
        looks: Map<number, LookChoice>;
        lookErrors: Map<number, ReviewError>;
      };
    } = {},
  ): Promise<FastifyReply> {
    const review = await planReview(db, plan, userId);
    const { changed = false, refused } = state;
    return renderPage(
      reply,
      <ReviewPage
        ctx={viewContext(reply)}
        model={{
          plan,
          review,
          changed,
          posted: refused?.posted,
          errors: refused?.errors,
          postedLooks: refused?.looks,
          lookErrors: refused?.lookErrors,
        }}
      />,
      { status: changed || refused ? 400 : 200 },
    );
  }

  app.get(
    `${PLANS_PATH}/:id/review`,
    { schema: { params: PlanParams } },
    async (request, reply) => {
      const plan = await requirePlan(request, request.params.id);
      return renderReview(reply, plan, sessionUserId(request));
    },
  );

  // "Accept these" (review.ts has the rule): a post the page could not have
  // sent, or naming an item no longer the plan's (deleted meanwhile), comes
  // back as the page as it stands now, 400, with nothing written; one with
  // a strip's error (Change this without a note, a rejected candidate as
  // the pick) comes back as posted, 400, nothing written; another user's
  // plan is a 404 first.
  app.post(
    `${PLANS_PATH}/:id/review`,
    { schema: { params: PlanParams, body: ReviewBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      const { body } = request;
      const read = readReview(reviewPostOf(body));
      if (!read.ok) {
        const plan = await requirePlan(request, id);
        logger.warn(`Plan ${id} review refused: picks do not match shown`);
        return renderReview(reply, plan, userId, { changed: true });
      }
      const { choices, errors, lookErrors } = read;
      if (errors.size > 0 || lookErrors.size > 0) {
        const plan = await requirePlan(request, id);
        logger.warn(
          `Plan ${id} review refused: ${[
            ...[...errors].map(([item, error]) => `item ${item} ${error}`),
            ...[...lookErrors].map(([look, error]) => `look ${look} ${error}`),
          ].join(', ')}`,
        );
        return renderReview(reply, plan, userId, {
          refused: {
            posted: choices,
            errors,
            looks: read.looks,
            lookErrors,
          },
        });
      }
      const { removeUnpicked, activate } = body;
      const outcome = await applyReview(options, userId, id, {
        shown: [...choices.keys()],
        choices,
        looks: read.looks,
        removeUnpicked: removeUnpicked === '1',
        activate: activate === '1',
      });
      if (!outcome.ok) {
        if (outcome.reason === 'not-found') throw planNotFound();
        logger.warn(
          `Plan ${id} review refused: items ${outcome.itemIds.join(', ')} are not the plan's`,
        );
        return renderReview(reply, await requirePlan(request, id), userId, {
          changed: true,
        });
      }
      const removed = outcome.removed.length;
      return reply.redirect(
        `${planUrl(id)}?reviewed=1${removed > 0 ? `&removed=${removed}` : ''}`,
        303,
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
      const form = readPlanForm(request.body);
      if (!form.ok) {
        // Another's plan is a 404 before its form comes back. A valid post
        // needs no lookup: updatePlan answers 'not-found' itself.
        await requirePlan(request, id);
        return refusePlanForm(reply, form, id);
      }
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
      // All under the owner lock: the original is read as no other write
      // of the owner's leaves it, and the copy's name is chosen with the
      // insert (createGeneratedPlan), so a second tap names its copy apart.
      const copy = await ownerTransaction(
        db,
        userId,
        'duplicatePlan',
        async (tx) => {
          const plan = await findPlan(tx, request.params.id, userId);
          if (!plan) throw planNotFound();
          const [items, candidates] = await Promise.all([
            itemsOf(tx, [plan.id]),
            candidatesOfPlan(tx, userId, plan.id),
          ]);
          const { id } = await createGeneratedPlan(
            tx,
            userId,
            {
              base: plan.name,
              nameFor: (name, n) =>
                n === 1
                  ? t('plans.COPY_NAME', { name })
                  : t('plans.COPY_NAME_N', { name, n }),
            },
            plan.notes,
          );
          // Each item copied with its review, the owner's note and its
          // rejections (#278: the agent working on the copy never proposes a
          // declined item or adds a rejected product again), and with its
          // original's candidates, all in one change; a declined item's
          // candidates are inert and take no new link, so they stay behind.
          const copies = await copyItems(tx, id, items);
          const copyOf = new Map(
            items.map((item, index) => [item.id, copies[index]]),
          );
          await copyRejections(tx, copyOf);
          const links: CandidateAdd[] = [];
          for (const original of items) {
            const held = candidates.get(original.id) ?? [];
            if (held.length > 0 && original.review !== 'declined') {
              links.push({
                itemIds: [copyOf.get(original.id)!],
                garmentIds: held.map((candidate) => candidate.garmentId),
                // The agent's research travels with the product (#293).
                research: new Map(
                  held.map(({ garmentId, note, rank }) => [
                    garmentId,
                    { note, rank },
                  ]),
                ),
              });
            }
          }
          if (links.length > 0) {
            await changeCandidates(tx, userId, { add: links });
          }
          // After the candidates, so each copied look's pieces stand as they
          // did (#290); a declined look comes too, its set remembered.
          const looks = await copyLooks(tx, plan.id, id);
          return { id, items: items.length, linked: links.length, looks };
        },
      );
      logger.info(
        `Plan ${request.params.id} duplicated by user ${userId} as plan ${copy.id} (${copy.items} items, ${copy.linked} with candidates, ${copy.looks} looks)`,
      );
      return reply.redirect(`${planUrl(copy.id)}?created=1`, 303);
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
      const planId = request.params.id;
      const form = readPlanItemForm(request.body);
      if (!form.ok) {
        const plan = await requirePlan(request, planId);
        return refuseItemForm(reply, plan, form, userId);
      }
      // addItems looks the plan up under the owner lock: no read before it.
      const added = await addItems(db, userId, planId, [form.fields], {
        review: 'accepted',
      });
      if (!added) throw planNotFound();
      const [itemId] = added;
      logger.info(
        `Plan item ${itemId} added to plan ${planId} by user ${userId}`,
      );
      return reply.redirect(`${planUrl(planId)}?saved=1`, 303);
    },
  );

  /**
   * The 404 of an item write that matched nothing: the plan's when the plan
   * is not the owner's, else the item's. The plan is read only then, so a
   * write that lands reads nothing before it (its guard is ownsPlan).
   */
  async function itemMiss(
    request: FastifyRequest,
    planId: number,
  ): Promise<HttpError> {
    await requirePlan(request, planId);
    return itemNotFound();
  }

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
          review: item.review,
          ownerNote: item.ownerNote,
          values: storedItemValues(item),
        },
        userId,
      );
    },
  );

  // The owner's save rewrites the item whole and accepts it if their agent
  // proposed it or it waits on a change: reviewing it in the form is
  // accepting it. A declined item takes no save (a 409): Reconsider first.
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
        'owner',
      );
      if (!saved.ok) {
        if (saved.reason === 'not-found') throw itemNotFound();
        throw new HttpError(409, t('plans.DECLINED_EDIT_HINT'));
      }
      logger.info(
        `Plan item ${item.id} of plan ${plan.id} updated by user ${userId}${saved.from === saved.to ? '' : ` (${saved.from} to ${saved.to})`}`,
      );
      return reply.redirect(`${planUrl(plan.id)}?saved=1`, 303);
    },
  );

  /**
   * The owner's review move `event` on item `itemId` of plan `id`
   * (reviewItems asks the machine): its 404 when no item of the owner's
   * plan, a 409 when the item's review does not take the move (a second
   * tap, a stale page: it moved already), else back to the plan.
   */
  async function moveItem(
    request: FastifyRequest,
    { id, itemId }: { id: number; itemId: number },
    reply: FastifyReply,
    event: PlanItemReviewEvent,
    note: string | null = null,
  ): Promise<FastifyReply> {
    const userId = sessionUserId(request);
    const { moved, refused } = await reviewItems(db, userId, id, event, [
      { itemId, note },
    ]);
    if (refused.length > 0) {
      logger.warn(
        `Plan item ${itemId} of plan ${id}: ${event} refused for user ${userId}, the item is ${refused[0].review}`,
      );
      throw new HttpError(409, t('plans.ALREADY_MOVED'));
    }
    if (moved.length === 0) throw await itemMiss(request, id);
    logger.info(
      `Plan item ${itemId} of plan ${id}: ${event} by user ${userId}${note ? ' with a note' : ''}`,
    );
    return reply.redirect(`${planUrl(id)}?saved=1`, 303);
  }

  app.post(
    `${PLANS_PATH}/:id/items/:itemId/accept`,
    { schema: { params: ItemParams } },
    (request, reply) => moveItem(request, request.params, reply, 'accept'),
  );

  // "Don't buy" (#278): declined, kept so the agent never proposes it again.
  app.post(
    `${PLANS_PATH}/:id/items/:itemId/decline`,
    { schema: { params: ItemParams, body: DeclineBody } },
    (request, reply) =>
      moveItem(
        request,
        request.params,
        reply,
        'decline',
        request.body?.note?.trim() || null,
      ),
  );

  app.post(
    `${PLANS_PATH}/:id/items/:itemId/reconsider`,
    { schema: { params: ItemParams } },
    (request, reply) => moveItem(request, request.params, reply, 'reconsider'),
  );

  // "Change this…" (#278): the note for the agent is required, so a form of
  // its own (a blank note is the form again, 400).
  app.get(
    `${PLANS_PATH}/:id/items/:itemId/change`,
    { schema: { params: ItemParams } },
    async (request, reply) => {
      const { plan, item } = await requireItem(
        request,
        request.params.id,
        request.params.itemId,
      );
      return renderPage(
        reply,
        <ChangeItemPage ctx={viewContext(reply)} model={{ plan, item }} />,
      );
    },
  );

  app.post(
    `${PLANS_PATH}/:id/items/:itemId/change`,
    { schema: { params: ItemParams, body: ChangeBody } },
    async (request, reply) => {
      const note = request.body.note.trim();
      if (note === '') {
        const { plan, item } = await requireItem(
          request,
          request.params.id,
          request.params.itemId,
        );
        return renderPage(
          reply,
          <ChangeItemPage
            ctx={viewContext(reply)}
            model={{ plan, item, note: request.body.note, error: true }}
          />,
          { status: 400 },
        );
      }
      return moveItem(request, request.params, reply, 'change', note);
    },
  );

  // ---- A look's reactions from the plan page (#291) ----------------------------

  /**
   * The owner's reaction `event` on look `lookId` of plan `id` through
   * reactToLooks (the machine, src/wardrobe/look-reaction.ts): the plan's
   * 404 when it is not the owner's, the look's when it is no look of the
   * plan, a 409 when the look's reaction does not take the move (a second
   * tap, a stale page), else back to the plan.
   */
  async function moveLook(
    request: FastifyRequest,
    { id, lookId }: { id: number; lookId: number },
    reply: FastifyReply,
    event: Exclude<LookReactionEvent, 'repropose'>,
    note: string | null = null,
  ): Promise<FastifyReply> {
    const userId = sessionUserId(request);
    const { moved, refused } = await reactToLooks(db, userId, id, event, [
      { lookId, note },
    ]);
    if (refused.length > 0) {
      logger.warn(
        `Look ${lookId} of plan ${id}: ${event} refused for user ${userId}, the look is ${refused[0].reaction}`,
      );
      throw new HttpError(409, t('plans.looks.ALREADY_MOVED'));
    }
    if (moved.length === 0) {
      await requirePlan(request, id);
      throw lookNotFound();
    }
    logger.info(
      `Look ${lookId} of plan ${id}: ${event} by user ${userId}${note ? ' with a note' : ''}`,
    );
    // Back to the Outfits view the look was reacted to in.
    return reply.redirect(`${planViewUrl(id, 'outfits')}&saved=1`, 303);
  }

  app.post(
    `${PLANS_PATH}/:id/looks/:lookId/love`,
    { schema: { params: LookParams } },
    (request, reply) => moveLook(request, request.params, reply, 'love'),
  );

  // "Not for me": kept, so the agent never proposes the same pieces again.
  app.post(
    `${PLANS_PATH}/:id/looks/:lookId/decline`,
    { schema: { params: LookParams, body: DeclineBody } },
    (request, reply) =>
      moveLook(
        request,
        request.params,
        reply,
        'decline',
        request.body?.note?.trim() || null,
      ),
  );

  app.post(
    `${PLANS_PATH}/:id/looks/:lookId/reconsider`,
    { schema: { params: LookParams } },
    (request, reply) => moveLook(request, request.params, reply, 'reconsider'),
  );

  // Save as outfit (#292): a look whose every piece is owned becomes an
  // outfit (saveLookAsOutfit, through createOutfit), then its page, saying
  // "Already saved" when nothing was created. A piece to buy or missing, or
  // a declined look, is a 409 with nothing written.
  app.post(
    `${PLANS_PATH}/:id/looks/:lookId/save`,
    { schema: { params: LookParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id, lookId } = request.params;
      const saved = await saveLookAsOutfit(db, userId, id, lookId);
      if (saved === 'not-found') {
        await requirePlan(request, id);
        throw lookNotFound();
      }
      logger.info(
        `Look ${lookId} of plan ${id} saved as outfit ${saved.outfitId} by user ${userId}${saved.alreadySaved ? ' (nothing created: already an outfit)' : ''}`,
      );
      const flag = saved.alreadySaved ? `?${ALREADY_SAVED_FLAG}=1` : '';
      return reply.redirect(`${outfitUrl(saved.outfitId)}${flag}`, 303);
    },
  );

  /** The owner's plan and its look `lookId`, else the plan's 404, then the look's. */
  async function requireLook(
    request: FastifyRequest,
    { id, lookId }: { id: number; lookId: number },
  ) {
    const userId = sessionUserId(request);
    const [plan, looks] = await Promise.all([
      requirePlan(request, id),
      looksOfPlan(db, userId, id),
    ]);
    const look = looks.find((candidate) => candidate.id === lookId);
    if (!look) throw lookNotFound();
    return { plan, look };
  }

  // "Change this…": the note for the agent is required, so a form of its own
  // (a blank note is the form again, 400), as an item's.
  app.get(
    `${PLANS_PATH}/:id/looks/:lookId/change`,
    { schema: { params: LookParams } },
    async (request, reply) => {
      const { plan, look } = await requireLook(request, request.params);
      return renderPage(
        reply,
        <ChangeLookPage ctx={viewContext(reply)} model={{ plan, look }} />,
      );
    },
  );

  app.post(
    `${PLANS_PATH}/:id/looks/:lookId/change`,
    { schema: { params: LookParams, body: ChangeBody } },
    async (request, reply) => {
      const note = request.body.note.trim();
      if (note === '') {
        const { plan, look } = await requireLook(request, request.params);
        return renderPage(
          reply,
          <ChangeLookPage
            ctx={viewContext(reply)}
            model={{ plan, look, note: request.body.note, error: true }}
          />,
          { status: 400 },
        );
      }
      return moveLook(request, request.params, reply, 'change', note);
    },
  );

  // htmx: the edit form's Delete; back to the plan.
  app.delete(
    `${PLANS_PATH}/:id/items/:itemId`,
    { schema: { params: ItemParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id, itemId } = request.params;
      if ((await deleteItems(db, [itemId], id, userId)).length === 0) {
        throw await itemMiss(request, id);
      }
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
      const userId = sessionUserId(request);
      // One statement (#251; it was one per part), each part its module's:
      // the profile, the week template its rhythm comes from, and the home
      // city, read-only, the weather's (#14, user_weather, never a second
      // copy), not read with WEATHER_ENABLED off.
      const read = await selectScalars(db, {
        profile: styleProfileSql(userId),
        template: weekTemplateSql(userId),
        home: options.weather ? homeNameSql(userId) : undefined,
      });
      return renderPage(
        reply,
        <StyleProfilePage
          ctx={viewContext(reply)}
          model={{
            values: styleProfilePost(read.profile ?? EMPTY_STYLE_PROFILE),
            rhythm: weeklyRhythm(inTemplateOrder(read.template)),
            home: options.weather ? { name: read.home ?? null } : undefined,
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
