import { PostForm } from '../auth/form';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState } from '../layout/parts';
import { OutfitCollage } from '../outfits/collage';
import type { SharedWardrobe } from '../sharing/access';
import type { ViewContext } from '../view-context';
import { WardrobeHeader, WardrobeTabs } from '../wardrobe/wardrobe-header';
import type { CoverCell, PlanCover } from './covers';
import { awaitingReview, type PlanGaps } from './gaps';
import { lookGarments } from './look-tile';
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
  /** Each plan's photo row and looks (planCovers), by plan id. */
  covers: ReadonlyMap<number, PlanCover>;
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
                  <PlanCard
                    gaps={gaps}
                    cover={model.covers.get(gaps.plan.id)}
                  />
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
 * A plan: its name (a stretched link to the gap view), its photo row, what
 * it holds ("12 items · 3 looks · 4 to buy": the items asked for, the
 * agent's looks, and the items still to get), the agent that drafted it
 * (its token's name) and its proposals awaiting the owner, with Review
 * (#271).
 */
function PlanCard(props: { gaps: PlanGaps; cover: PlanCover | undefined }) {
  const { gaps, cover } = props;
  const { plan, tally } = gaps;
  const awaiting = awaitingReview(gaps);
  const items = tally.owned + tally.partly + tally.missing;
  const looks = cover?.looks ?? 0;
  const counts = [
    items === 1 ? t('plans.ITEMS_ONE') : t('plans.ITEMS', { count: items }),
    looks === 1 ? t('plans.LOOKS_ONE') : t('plans.LOOKS', { count: looks }),
    t('plans.looks.TO_BUY_COUNT', { count: tally.partly + tally.missing }),
  ].join(' · ');
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
        {cover && cover.cells.length > 0 && <CoverRow cells={cover.cells} />}
        <p class="text-sm text-base-content/70">{counts}</p>
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

/**
 * Up to five 4:5 cells in a fixed grid, so a plan with fewer photos keeps
 * the cells' size (left-aligned): a look's collage, or a candidate's photo.
 * Decorative: the card's link is the name.
 */
function CoverRow({ cells }: { cells: readonly CoverCell[] }) {
  return (
    <div class="grid grid-cols-5 gap-1.5 my-1" data-plan-cover="">
      {cells.map((cell) => (
        <div data-cover-cell={cell.kind}>
          {cell.kind === 'look' ? (
            <OutfitCollage garments={lookGarments(cell)} size="cover" />
          ) : (
            <div class="bg-base-200 rounded-field aspect-[4/5] p-1 flex items-center justify-center">
              <img
                src={imageUrl(cell.photo, 'thumb')}
                alt={cell.name ?? ''}
                class="max-h-full max-w-full object-contain"
                width="200"
                height="200"
                loading="lazy"
                decoding="async"
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
