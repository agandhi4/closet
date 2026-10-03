import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState } from '../layout/parts';
import type { SharedWardrobe } from '../sharing/access';
import type { ViewContext } from '../view-context';
import { WardrobeHeader, WardrobeTabs } from '../wardrobe/wardrobe-header';
import { awaitingReview, type PlanGaps } from './gaps';
import {
  COMPARE_PATH,
  NEW_PLAN_PATH,
  PLANS_PATH,
  planUrl,
  reviewUrl,
  SHOPPING_PATH,
  STYLE_PROFILE_PATH,
} from './urls';

/** A wardrobe a plan can start from: the requester's own, or one shared with them. */
export interface PlanSource {
  ownerId: number;
  /** null: the requester's own closet. */
  name: string | null;
}

export interface PlansModel {
  /** Every plan of the owner's, active first, measured against the closet. */
  plans: PlanGaps[];
  sources: PlanSource[];
  /** The wardrobes shared with the requester: the header's switcher. */
  sharedWardrobes: SharedWardrobe[];
}

/**
 * GET /wardrobe/plans: the owner's wardrobe plans (#34), the Wardrobe's
 * Plans tab (#295), always the requester's own like Laundry, so the header
 * is theirs and "New plan" is in its add sheet. Each plan with how the closet measures up (the active
 * one first, marked), a new blank plan, and "start from a wardrobe": the
 * closet of a wardrobe shared with them (the demo, Theo's, is the owner's
 * target) or their own, copied as plan items.
 */
export function PlansPage(props: { ctx: ViewContext; model: PlansModel }) {
  const { ctx, model } = props;
  return (
    <Layout ctx={ctx} title={t('plans.TITLE')}>
      <WardrobeHeader
        ctx={ctx}
        tab="plans"
        viewOwner={undefined}
        sharedWardrobes={model.sharedWardrobes}
        canEdit
        newPlan
      />
      <div class="pt-16">
        <WardrobeTabs active="plans" viewOwner={undefined} />
        <main class="p-4 pb-24 w-full sm:max-w-lg sm:mx-auto flex flex-col gap-5">
          <p class="text-sm text-base-content/70">
            {t('plans.INTRO')}{' '}
            <a href={STYLE_PROFILE_PATH} class="link link-primary">
              {t('style.TITLE')}
            </a>
          </p>

          {model.plans.length === 0 ? (
            <EmptyState message={t('plans.EMPTY')}>
              <a href={NEW_PLAN_PATH} class="btn btn-primary btn-sm">
                + {t('plans.NEW_PLAN')}
              </a>
            </EmptyState>
          ) : (
            <>
              <ul class="flex flex-col gap-2" id="plans">
                {model.plans.map((gaps) => (
                  <PlanCard gaps={gaps} />
                ))}
              </ul>
              <div class="flex gap-2">
                <a href={SHOPPING_PATH} class="btn btn-outline btn-sm flex-1">
                  {t('shopping.TITLE')}
                </a>
                {model.plans.length > 1 && (
                  <a href={COMPARE_PATH} class="btn btn-outline btn-sm flex-1">
                    {t('shopping.COMPARE_TITLE')}
                  </a>
                )}
              </div>
            </>
          )}

          <section aria-labelledby="start-from">
            <h2
              id="start-from"
              class="text-xs font-semibold uppercase tracking-wide text-muted mb-2"
            >
              {t('plans.START_FROM')}
            </h2>
            <p class="text-xs text-muted mb-2">{t('plans.START_FROM_HINT')}</p>
            <PostForm
              action={`${PLANS_PATH}/from-wardrobe`}
              class="flex flex-col gap-2"
              needsNetwork
            >
              {model.sources.map((source) => (
                <button
                  type="submit"
                  name="ownerId"
                  value={String(source.ownerId)}
                  class="btn btn-outline justify-start"
                >
                  {source.name === null
                    ? t('plans.FROM_MY_CLOSET')
                    : t('plans.FROM_WARDROBE', { name: source.name })}
                </button>
              ))}
            </PostForm>
          </section>
        </main>
      </div>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * A plan: its name (a stretched link to the gap view), the closet's tally,
 * the agent that drafted it (its token's name) and its proposals awaiting
 * the owner, with Review (#271).
 */
function PlanCard({ gaps }: { gaps: PlanGaps }) {
  const { plan, tally } = gaps;
  const awaiting = awaitingReview(gaps);
  return (
    <li class="card bg-base-100 shadow-sm relative">
      <div class="card-body p-3 gap-1">
        <div class="flex items-center gap-2">
          <a
            href={planUrl(plan.id)}
            class="card-title text-base min-w-0 truncate after:absolute after:inset-0"
          >
            {plan.name}
          </a>
          {plan.active && (
            <span class="badge badge-primary badge-sm">
              {t('plans.ACTIVE')}
            </span>
          )}
        </div>
        <p class="text-sm text-base-content/70">{t('plans.TALLY', tally)}</p>
        {plan.draftedBy !== null && (
          <p class="text-xs text-muted">
            {t('plans.DRAFTED_BY', { name: plan.draftedBy })}
          </p>
        )}
        {awaiting > 0 && (
          <p class="text-xs text-primary flex items-center justify-between gap-2">
            {t('plans.PROPOSED_COUNT', { count: awaiting })}
            {/* Above the card's stretched link. */}
            <a
              href={reviewUrl(plan.id)}
              class="btn btn-primary btn-xs relative z-10"
            >
              {t('plans.REVIEW')}
            </a>
          </p>
        )}
      </div>
    </li>
  );
}
