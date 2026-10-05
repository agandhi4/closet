import {
  type BudgetFit,
  fromCents,
  type ShoppingEntry,
} from '../../wardrobe/shopping';
import { imageUrl } from '../files/image-url';
import { OutfitCountSlot } from '../gallery/goes-with';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { CANDIDATE_GRID } from '../layout/columns';
import { PageMain } from '../layout/page-main';
import { EmptyState, HangerIcon } from '../layout/parts';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import { priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import {
  AgentsPick,
  candidateName,
  CandidateNote,
  InLooks,
  isAgentsPick,
  PriceLine,
} from './candidate-tile';
import { differencesText, itemFacts, itemTitle, priorityLabel } from './labels';
import type { PlanDetail, PlanItemRow } from './queries';
import type { ListedCandidate, PlanShoppingList } from './shopping';
import {
  candidateAnchor,
  candidatesUrl,
  PLANS_PATH,
  planUrl,
  shoppingUrl,
} from './urls';

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
 * piece and its candidate products as a grid of cards in the plan's item
 * view language (#316): a large photo, the name, one price line against the
 * budget, the product link and "Bought it"; two across on a phone, four at
 * `lg`. At the top what it all adds up to and "Style with my closet".
 * Every action a plain link. A candidate is added from the item ("Add a product"
 * when it has none: a link, a photo, or something already on the
 * wishlist). Private: the signed-in owner's.
 */
export function ShoppingPage(props: {
  ctx: ViewContext;
  model: ShoppingPageModel;
}) {
  const { ctx, model } = props;
  const { plan, list } = model;
  const anyCandidates = list?.entries.some((e) => e.candidates.length > 0);
  return (
    <Layout ctx={ctx} title={t('shopping.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('shopping.TITLE')}
        back={plan ? planUrl(plan.id) : PLANS_PATH}
      />
      <PageMain width="wide" class="p-4 pt-20 pb-24 flex flex-col gap-4">
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
            {anyCandidates && (
              <a
                href={stylingUrl({ planId: plan.id })}
                class="btn btn-outline btn-sm self-start"
                data-style-with-closet=""
              >
                {t('plans.STYLE_WITH_CLOSET')}
              </a>
            )}
            <ul class="flex flex-col gap-4" id="shopping-list">
              {list.entries.map((entry) => (
                <ItemCard entry={entry} plan={plan} />
              ))}
            </ul>
          </>
        )}
      </PageMain>
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
          {totals.withoutPricedMatch > 0 &&
            ` · ${t('shopping.SUMMARY_WITHOUT_PRICED_MATCH', { count: totals.withoutPricedMatch })}`}
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
      <div class="card-body p-3 pb-0 gap-2">
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
      </div>
      {entry.candidates.length > 0 && (
        <ul
          class={`${CANDIDATE_GRID} px-3 pt-2`}
          aria-label={t('shopping.STRIP_LABEL', { item: itemTitle(item) })}
        >
          {entry.candidates.map(({ candidate, budget }) => (
            <CandidateCard
              itemId={item.id}
              candidate={candidate}
              budget={budget}
            />
          ))}
        </ul>
      )}
      <div class="card-body p-3 gap-2">
        {entry.candidates.length === 0 && (
          <p class="text-sm text-muted">{t('shopping.NO_CANDIDATES')}</p>
        )}
        <a
          href={candidatesUrl(plan.id, item.id, shoppingUrl(plan))}
          class="btn btn-outline btn-sm"
        >
          +{' '}
          {t(
            entry.candidates.length === 0
              ? 'shopping.ADD_PRODUCT'
              : 'shopping.ADD_CANDIDATE',
          )}
        </a>
      </div>
    </li>
  );
}

/**
 * A candidate as a card of the item's grid, in the item view's language: a
 * large photo and its name (a link to its wishlist page), then one price
 * line against the budget, and what else helps the choice (kind mismatch,
 * the agent's note, outfits it makes) with the product link and "Bought
 * it". The photo is its own `<span>` inside the link, the element a viewer
 * can later opt into. The `id` is where Today's next-step card lands.
 */
function CandidateCard(props: {
  itemId: number;
  candidate: ListedCandidate;
  budget: BudgetFit;
}) {
  const { itemId, candidate, budget } = props;
  return (
    <li
      class="flex flex-col gap-1 scroll-mt-20"
      id={candidateAnchor(itemId, candidate.garmentId)}
      data-budget={budget}
      data-matches={String(candidate.matches)}
    >
      <a
        href={garmentUrl(candidate.garmentId, undefined)}
        class="flex flex-col gap-1 no-underline"
      >
        <span class="aspect-square w-full rounded-box bg-base-200 flex items-center justify-center p-2">
          {candidate.photo ? (
            <img
              src={imageUrl(candidate.photo, 'thumb')}
              alt=""
              class="max-h-full max-w-full object-contain"
              width="400"
              height="400"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <HangerIcon class="size-10 text-faint" strokeWidth="1" />
          )}
        </span>
        <span class="text-sm font-medium truncate">
          {candidateName(candidate)}
        </span>
      </a>
      <span class="text-xs text-muted flex flex-col gap-0.5">
        {isAgentsPick(candidate) && <AgentsPick />}
        <InLooks looks={candidate.looks} />
        {candidate.brand && <span>{candidate.brand}</span>}
        <PriceLine candidate={candidate} budget={budget} />
        <CandidateNote candidate={candidate} />
        {!candidate.matches && (
          <span class="text-warning" data-mismatch>
            {t('shopping.DOESNT_MATCH', {
              differences: differencesText(candidate.differences),
            })}
          </span>
        )}
        <OutfitCountSlot garmentId={candidate.garmentId} />
      </span>
      <span class="flex flex-wrap gap-1 pt-1">
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
    </li>
  );
}
