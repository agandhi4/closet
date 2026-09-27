import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, GarmentThumb } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import {
  destinationParams,
  garmentUrl,
  LINK_IMPORT_PATH,
  wardrobeUrl,
} from '../wardrobe/urls';
import type { WishlistItem } from '../wishlist/queries';
import type { ItemStatus } from '../../wardrobe/plans';
import type { Candidacy } from './candidates';
import type { PlanGaps } from './gaps';
import { itemFacts, itemTitle } from './labels';
import type { PlanDetail, PlanItemRow } from './queries';
import {
  candidatesUrl,
  garmentPlanItemsUrl,
  PLANS_PATH,
  planUrl,
} from './urls';

export interface ItemCandidatesModel {
  plan: PlanDetail;
  item: PlanItemRow;
  /** The owner's wishlist, newest first. */
  wishlist: WishlistItem[];
  /** The wishlist items that are its candidates now. */
  chosen: Set<number>;
  /**
   * Where the page came from and saving goes back to (safeReturnTo'd: the
   * shopping list); undefined: the plan, whose page then says Saved.
   */
  returnTo: string | undefined;
}

/**
 * GET /wardrobe/plans/:id/items/:itemId/candidates (34b): a plan item's
 * candidate products. New ones come from a link or a photo (the wishlist's
 * own add, carrying `planItem` so the save links it), or from what is on
 * the wishlist already: a checkbox per wishlist item, the candidates ticked.
 * The form posts what it showed (`shown`) beside what is ticked, so an item
 * added to the wishlist meanwhile is never unlinked by a stale page (the
 * capsule picker's rule).
 */
export function ItemCandidatesPage(props: {
  ctx: ViewContext;
  model: ItemCandidatesModel;
}) {
  const { ctx, model } = props;
  const { plan, item } = model;
  const title = t('shopping.CANDIDATES_TITLE', { item: itemTitle(item) });
  const destination = destinationParams({ to: 'wishlist', planItem: item.id });
  const facts = itemFacts(item);
  return (
    <Layout ctx={ctx} title={title}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <BackLink href={model.returnTo ?? planUrl(plan.id)} />
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-bold break-words">{title}</h1>
            <p class="text-sm text-base-content/60 truncate">{plan.name}</p>
          </div>
        </div>
        {(facts.length > 0 || item.budget) && (
          <p class="text-sm text-base-content/70">
            {[
              ...facts,
              item.budget
                ? t('shopping.UP_TO', { price: priceLabel(item.budget) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        <p class="text-sm text-base-content/70">
          {t('shopping.CANDIDATES_INTRO')}
        </p>
        <div class="grid grid-cols-2 gap-2">
          <a
            href={wardrobeUrl(undefined, destination, LINK_IMPORT_PATH)}
            class="btn btn-outline btn-sm"
          >
            {t('wishlist.ADD_FROM_LINK')}
          </a>
          <a
            href={wardrobeUrl(undefined, destination, '/wardrobe/new')}
            class="btn btn-outline btn-sm"
          >
            {t('shopping.ADD_WITH_PHOTO')}
          </a>
        </div>
        <section aria-labelledby="from-wishlist">
          <h2
            id="from-wishlist"
            class="text-xs font-semibold uppercase tracking-wide text-base-content/50 mb-2"
          >
            {t('shopping.FROM_WISHLIST')}
          </h2>
          {model.wishlist.length === 0 ? (
            <p class="text-sm text-base-content/60">
              {t('shopping.WISHLIST_EMPTY')}
            </p>
          ) : (
            <PostForm
              action={candidatesUrl(plan.id, item.id)}
              class="flex flex-col gap-2"
              needsNetwork
            >
              {model.returnTo && (
                <input type="hidden" name="returnTo" value={model.returnTo} />
              )}
              <ul class="flex flex-col gap-2" id="candidate-choices">
                {model.wishlist.map((garment) => (
                  <li>
                    <input
                      type="hidden"
                      name="shown"
                      value={String(garment.id)}
                    />
                    <label class="card card-side bg-base-100 shadow-sm cursor-pointer items-center">
                      <GarmentThumb
                        garment={garment}
                        class="rounded-l-box shrink-0"
                      />
                      <span class="flex-1 min-w-0 px-3 flex flex-col">
                        <span class="font-medium text-sm break-words">
                          {garment.name ?? categoryLabel(garment.category)}
                        </span>
                        <span class="text-xs text-base-content/60">
                          {[
                            garment.brand,
                            garment.price ? priceLabel(garment.price) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        name="garmentIds"
                        value={String(garment.id)}
                        class="checkbox checkbox-primary mr-3"
                        checked={model.chosen.has(garment.id)}
                      />
                    </label>
                  </li>
                ))}
              </ul>
              <button type="submit" class="btn btn-primary" data-needs-network>
                {t('SAVE')}
              </button>
            </PostForm>
          )}
        </section>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

export interface GarmentPlanItemsModel {
  garment: { id: number; name: string | null; category: string };
  /** The owner's plans, active first, each measured (the items grouped by status). */
  plans: PlanGaps[];
  /** The items the garment is a candidate for now. */
  chosen: Set<number>;
}

const STATUS_ORDER: readonly ItemStatus[] = ['missing', 'partly', 'owned'];

/**
 * GET /wardrobe/:id/plan-items (34b): a wishlist item's "For plan item…",
 * the other side of the same link: the owner's plans (active first), each
 * item a checkbox (the gaps first, proposals last), the ones it is a
 * candidate for ticked. Posts what it showed, like the item's page.
 */
export function GarmentPlanItemsPage(props: {
  ctx: ViewContext;
  model: GarmentPlanItemsModel;
}) {
  const { ctx, model } = props;
  const { garment } = model;
  const name = garment.name ?? categoryLabel(garment.category);
  const title = t('shopping.PLAN_ITEMS_TITLE', { name });
  return (
    <Layout ctx={ctx} title={title}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-4">
        <div class="flex items-center gap-3">
          <BackLink href={garmentUrl(garment.id, undefined)} />
          <h1 class="text-2xl font-bold break-words flex-1 min-w-0">{title}</h1>
        </div>
        <p class="text-sm text-base-content/70">
          {t('shopping.PLAN_ITEMS_INTRO')}
        </p>
        {model.plans.length === 0 ? (
          <p class="text-sm text-base-content/60">
            {t('plans.EMPTY')}{' '}
            <a href={PLANS_PATH} class="link link-primary">
              {t('plans.TITLE')}
            </a>
          </p>
        ) : (
          <PostForm
            action={garmentPlanItemsUrl(garment.id)}
            class="flex flex-col gap-4"
            needsNetwork
          >
            {model.plans.map((gaps) => (
              <fieldset class="flex flex-col gap-1" id={`plan-${gaps.plan.id}`}>
                <legend class="text-xs font-semibold uppercase tracking-wide text-base-content/50 mb-1">
                  {gaps.plan.name}
                  {gaps.plan.active && ` · ${t('plans.ACTIVE')}`}
                </legend>
                {[
                  ...STATUS_ORDER.flatMap((status) =>
                    gaps.groups[status].map(({ item }) => ({ item, status })),
                  ),
                  ...gaps.proposed.map((item) => ({
                    item,
                    status: 'proposed' as const,
                  })),
                ].map(({ item, status }) => (
                  <ItemChoice
                    item={item}
                    status={status}
                    checked={model.chosen.has(item.id)}
                  />
                ))}
              </fieldset>
            ))}
            <button type="submit" class="btn btn-primary" data-needs-network>
              {t('SAVE')}
            </button>
          </PostForm>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

const STATUS_LABELS = {
  missing: 'plans.MISSING',
  partly: 'plans.PARTLY',
  owned: 'plans.OWNED',
  proposed: 'plans.PROPOSED',
} as const;

function ItemChoice(props: {
  item: PlanItemRow;
  status: ItemStatus | 'proposed';
  checked: boolean;
}) {
  const { item, status } = props;
  return (
    <label class="label cursor-pointer justify-start gap-3 whitespace-normal">
      <input type="hidden" name="shown" value={String(item.id)} />
      <input
        type="checkbox"
        name="itemIds"
        value={String(item.id)}
        class="checkbox checkbox-sm checkbox-primary"
        checked={props.checked}
      />
      <span class="label-text flex-1 min-w-0">
        {itemTitle(item)}
        {item.quantity > 1 && ` ×${item.quantity}`}
      </span>
      <span class="badge badge-ghost badge-sm shrink-0" data-status={status}>
        {t(STATUS_LABELS[status])}
      </span>
    </label>
  );
}

/** A wishlist card's plan items (the owner's): "For Grey merino crewneck". */
export function CandidacyLinks(props: {
  garmentId: number;
  candidacies: readonly Candidacy[];
}) {
  return (
    <p class="text-xs flex flex-wrap items-center gap-1 relative z-10">
      {props.candidacies.map((candidacy) => (
        <a
          href={`${planUrl(candidacy.planId)}#plan-item-${candidacy.itemId}`}
          class="badge badge-outline badge-sm h-auto py-0.5"
        >
          {t('shopping.FOR_ITEM', { item: itemTitle(candidacy) })}
        </a>
      ))}
      <a href={garmentPlanItemsUrl(props.garmentId)} class="link link-primary">
        {t('shopping.FOR_PLAN_ITEM')}
      </a>
    </p>
  );
}
