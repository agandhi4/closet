import {
  type BudgetFit,
  fromCents,
  type ShoppingEntry,
} from '../../wardrobe/shopping';
import { OutfitCountSlot } from '../gallery/goes-with';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState, GarmentThumb } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import { differencesText, itemFacts, itemTitle, priorityLabel } from './labels';
import type { PlanDetail, PlanItemRow } from './queries';
import type { ListedCandidate, PlanShoppingList } from './shopping';
import { candidatesUrl, PLANS_PATH, planUrl, shoppingUrl } from './urls';

export interface ShoppingPageModel {
  /** The plan shown; undefined when the owner has no active plan (and asked for none). */
  plan: PlanDetail | undefined;
  list: PlanShoppingList | undefined;
}

type Entry = ShoppingEntry<PlanItemRow, ListedCandidate>;

/**
 * GET /wardrobe/shopping (34b): what the owner opens in a store. The active
 * plan's missing and partly owned items (another plan's with `?plan=`),
 * the highest priority first, each with how many to buy, the budget per
 * piece and its candidate products (photo, name, price against the
 * budget, the product link, "Bought it"), and at the top what it all adds
 * up to. Phone-first: one column of cards, every action a plain link. A
 * candidate is added from the item ("Add a candidate": a link, a photo, or
 * something already on the wishlist). Private: the signed-in owner's.
 */
export function ShoppingPage(props: {
  ctx: ViewContext;
  model: ShoppingPageModel;
}) {
  const { ctx, model } = props;
  const { plan, list } = model;
  return (
    <Layout ctx={ctx} title={t('shopping.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('shopping.TITLE')}
        back={plan ? planUrl(plan.id) : PLANS_PATH}
      />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-4">
        {plan && (
          <p class="text-sm text-muted truncate">
            <a href={planUrl(plan.id)} class="link link-hover">
              {plan.name}
            </a>
            {plan.active && (
              <span class="badge badge-primary badge-sm ml-2">
                {t('plans.ACTIVE')}
              </span>
            )}
          </p>
        )}
        {!plan || !list ? (
          <EmptyState message={t('shopping.NO_PLAN')}>
            <a href={PLANS_PATH} class="btn btn-primary btn-sm">
              {t('plans.TITLE')}
            </a>
          </EmptyState>
        ) : list.entries.length === 0 ? (
          <EmptyState
            message={t('shopping.NOTHING_TO_BUY', { plan: plan.name })}
          >
            <a href={planUrl(plan.id)} class="btn btn-outline btn-sm">
              {t('shopping.VIEW_PLAN')}
            </a>
          </EmptyState>
        ) : (
          <>
            <Summary list={list} />
            <ul class="flex flex-col gap-3" id="shopping-list">
              {list.entries.map((entry) => (
                <ItemCard entry={entry} plan={plan} />
              ))}
            </ul>
          </>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** What the list adds up to: pieces, the budget, and the cheapest candidates. */
function Summary({ list }: { list: PlanShoppingList }) {
  const { totals } = list;
  return (
    <section
      class="card bg-base-200"
      id="shopping-summary"
      aria-label={t('shopping.SUMMARY')}
    >
      <div class="card-body p-3 gap-1 text-sm">
        <p class="font-medium">
          {t('shopping.SUMMARY_ITEMS', {
            items: totals.items,
            pieces: totals.pieces,
          })}
        </p>
        <p data-total="budget">
          {t('shopping.SUMMARY_BUDGET', {
            total: priceLabel(fromCents(totals.budgetCents)),
          })}
          {totals.unbudgeted > 0 &&
            ` · ${t('shopping.SUMMARY_UNBUDGETED', { count: totals.unbudgeted })}`}
        </p>
        <p data-total="candidates">
          {t('shopping.SUMMARY_CHEAPEST', {
            total: priceLabel(fromCents(totals.cheapestCents)),
          })}
          {totals.uncovered > 0 &&
            ` · ${t('shopping.SUMMARY_UNCOVERED', { count: totals.uncovered })}`}
        </p>
      </div>
    </section>
  );
}

function ItemCard(props: { entry: Entry; plan: PlanDetail }) {
  const { entry, plan } = props;
  const { item, match } = entry;
  const facts = itemFacts(item);
  return (
    <li
      class="card bg-base-100 shadow-sm"
      id={`shopping-item-${item.id}`}
      data-status={match.status}
    >
      <div class="card-body p-3 gap-2">
        <div class="flex items-start justify-between gap-2">
          <h2 class="font-semibold min-w-0 break-words">{itemTitle(item)}</h2>
          <span class="flex items-center gap-1 shrink-0">
            <span class="badge badge-neutral badge-sm" data-to-buy>
              {t('shopping.TO_BUY', { count: entry.toBuy })}
            </span>
            {item.priority !== 'medium' && (
              <span
                class={`badge badge-sm ${item.priority === 'high' ? 'badge-warning' : 'badge-ghost'}`}
              >
                {priorityLabel(item.priority)}
              </span>
            )}
          </span>
        </div>
        <p class="text-xs text-muted">
          {[
            ...facts,
            match.status === 'partly'
              ? t('plans.HAVE_OF', { have: match.have, need: match.need })
              : null,
            item.budget
              ? t('shopping.UP_TO', { price: priceLabel(item.budget) })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {item.note && <p class="text-xs italic">{item.note}</p>}
        {entry.candidates.length === 0 ? (
          <p class="text-sm text-muted">{t('shopping.NO_CANDIDATES')}</p>
        ) : (
          <ul class="flex flex-col gap-2" aria-label={t('shopping.CANDIDATES')}>
            {entry.candidates.map(({ candidate, budget }) => (
              <CandidateRow candidate={candidate} budget={budget} />
            ))}
          </ul>
        )}
        <a
          href={candidatesUrl(plan.id, item.id, shoppingUrl(plan))}
          class="btn btn-outline btn-sm"
        >
          + {t('shopping.ADD_CANDIDATE')}
        </a>
      </div>
    </li>
  );
}

const BUDGET_BADGES: Record<BudgetFit, string | null> = {
  within: 'badge-success',
  over: 'badge-warning',
  unknown: null,
};

/**
 * A candidate: its photo, name and brand linking to its page, its price
 * against the budget, whether it is the kind of thing the item asks for,
 * how many outfits it makes with the closet, the product link and "Bought
 * it".
 */
function CandidateRow(props: {
  candidate: ListedCandidate;
  budget: BudgetFit;
}) {
  const { candidate, budget } = props;
  const name = candidate.name ?? categoryLabel(candidate.category);
  const badge = BUDGET_BADGES[budget];
  return (
    <li
      class="flex gap-3 items-start"
      id={`candidate-${candidate.garmentId}`}
      data-budget={budget}
      data-matches={String(candidate.matches)}
    >
      <a href={garmentUrl(candidate.garmentId, undefined)} class="shrink-0">
        <GarmentThumb garment={candidate} class="rounded-box" />
      </a>
      <div class="flex-1 min-w-0 flex flex-col gap-1">
        <a
          href={garmentUrl(candidate.garmentId, undefined)}
          class="font-medium text-sm link link-hover break-words"
        >
          {name}
        </a>
        {candidate.brand && (
          <span class="text-xs text-muted">{candidate.brand}</span>
        )}
        <span class="flex flex-wrap items-center gap-1 text-sm">
          {candidate.price && (
            <span class="font-medium">{priceLabel(candidate.price)}</span>
          )}
          {badge && (
            <span class={`badge badge-sm ${badge}`}>
              {t(
                budget === 'within'
                  ? 'shopping.WITHIN_BUDGET'
                  : 'shopping.OVER_BUDGET',
              )}
            </span>
          )}
        </span>
        <OutfitCountSlot garmentId={candidate.garmentId} />
        {!candidate.matches && (
          <p class="text-xs text-warning" data-mismatch>
            {t('shopping.DOESNT_MATCH', {
              differences: differencesText(candidate.differences),
            })}
          </p>
        )}
        <span class="flex flex-wrap gap-2 mt-1">
          {candidate.sourceUrl && (
            // http(s) only (readSourceUrl and the column's check); a new tab,
            // as on the garment page.
            <a
              href={candidate.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-ghost btn-xs"
            >
              {t('VIEW_PRODUCT')}
            </a>
          )}
          <a
            href={garmentUrl(candidate.garmentId, undefined, '/bought')}
            class="btn btn-primary btn-xs"
          >
            {t('wishlist.BOUGHT_IT')}
          </a>
        </span>
      </div>
    </li>
  );
}
