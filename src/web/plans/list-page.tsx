import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState } from '../layout/parts';
import type { ViewContext } from '../view-context';
import type { PlanGaps } from './gaps';
import {
  COMPARE_PATH,
  PLANS_PATH,
  planUrl,
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
}

/**
 * GET /wardrobe/plans: the owner's wardrobe plans (#34), reached from the
 * Wardrobe's ⋯ menu. Each plan with how the closet measures up (the active
 * one first, marked), a new blank plan, and "start from a wardrobe": the
 * closet of a wardrobe shared with them (the demo, Theo's, is the owner's
 * target) or their own, copied as plan items.
 */
export function PlansPage(props: { ctx: ViewContext; model: PlansModel }) {
  const { ctx, model } = props;
  return (
    <Layout ctx={ctx} title={t('plans.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('plans.TITLE')}
        back="/wardrobe"
        actions={
          <a href={`${PLANS_PATH}/new`} class="btn btn-primary btn-sm">
            + {t('plans.NEW_PLAN')}
          </a>
        }
      />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-5">
        <p class="text-sm text-base-content/70">
          {t('plans.INTRO')}{' '}
          <a href={STYLE_PROFILE_PATH} class="link link-primary">
            {t('style.TITLE')}
          </a>
        </p>

        {model.plans.length === 0 ? (
          <EmptyState message={t('plans.EMPTY')}>
            <a href={`${PLANS_PATH}/new`} class="btn btn-primary btn-sm">
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
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** A plan: its name (a stretched link to the gap view) and the closet's tally. */
function PlanCard({ gaps }: { gaps: PlanGaps }) {
  const { plan, tally, proposed } = gaps;
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
        {proposed.length > 0 && (
          <p class="text-xs text-primary">
            {t('plans.PROPOSED_COUNT', { count: proposed.length })}
          </p>
        )}
      </div>
    </li>
  );
}
