import type { ItemMatch, ItemStatus } from '../../wardrobe/plans';
import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import type { GapItem, PlanGaps } from './gaps';
import { itemFacts, itemTitle, priorityLabel } from './labels';
import type { ClosetGarment, PlanItemRow } from './queries';
import type { CandidateGarment, CandidatesByItem } from './candidates';
import {
  candidatesUrl,
  compareUrl,
  itemUrl,
  planUrl,
  PLANS_PATH,
  shoppingUrl,
} from './urls';

export interface PlanPageModel {
  gaps: PlanGaps;
  /** Each item's candidate products (34b): wishlist garments, by item id. */
  candidates: CandidatesByItem;
  /** The one-shot toast after a write (PlanPageQuery). */
  toast?: 'created' | 'saved';
}

/** The page's one-shot flags, stripped from the address once shown. */
const FLAGS = ['created', 'saved'] as const;

/** The groups in the order the page shows them: the gaps first. */
const GROUPS: readonly ItemStatus[] = ['missing', 'partly', 'owned'];

const GROUP_TITLES = {
  missing: 'plans.MISSING',
  partly: 'plans.PARTLY',
  owned: 'plans.OWNED',
} as const;

/**
 * GET /wardrobe/plans/:id, the gap view (#34, slice 34a): a plan's items
 * against the owner's closet, grouped missing, partly owned and owned
 * (the gaps first: what the page is for), each with what fulfils it and,
 * when it is not owned, why. Items the owner's agent proposed come first,
 * unmatched, with Accept and Dismiss. Private: the signed-in owner's plan
 * and closet only. A gap shows its candidate products (34b) and links to
 * adding one; the shopping list is the gaps with their candidates.
 */
export function PlanPage(props: { ctx: ViewContext; model: PlanPageModel }) {
  const { ctx, model } = props;
  const { plan, tally, proposed } = model.gaps;
  return (
    <Layout ctx={ctx} title={plan.name}>
      <AppBar
        ctx={ctx}
        title={plan.name}
        back={PLANS_PATH}
        actions={<PlanMenu gaps={model.gaps} />}
      />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-5">
        <p class="text-sm text-base-content/60" id="plan-tally">
          {plan.active && (
            <span class="badge badge-primary badge-sm mr-2">
              {t('plans.ACTIVE')}
            </span>
          )}
          {t('plans.TALLY', tally)}
        </p>
        {plan.notes && (
          <p class="text-sm whitespace-pre-line text-base-content/80">
            {plan.notes}
          </p>
        )}
        <div class="flex gap-2">
          <a href={itemUrl(plan.id, 'new')} class="btn btn-primary flex-1">
            + {t('plans.ADD_ITEM')}
          </a>
          {tally.missing + tally.partly > 0 && (
            <a href={shoppingUrl(plan)} class="btn btn-outline flex-1">
              {t('shopping.TITLE')}
            </a>
          )}
        </div>

        {proposed.length > 0 && (
          <section aria-labelledby="group-proposed">
            <GroupHeading id="group-proposed" count={proposed.length}>
              {t('plans.PROPOSED')}
            </GroupHeading>
            <p class="text-xs text-base-content/60 mb-2">
              {t('plans.PROPOSED_HINT')}
            </p>
            <ul class="flex flex-col gap-2">
              {proposed.map((item) => (
                <ProposedCard item={item} />
              ))}
            </ul>
          </section>
        )}

        {tally.owned + tally.partly + tally.missing === 0 ? (
          <p class="text-sm text-base-content/60 text-center pt-8">
            {t('plans.NO_ITEMS')}
          </p>
        ) : (
          GROUPS.map((status) =>
            model.gaps.groups[status].length === 0 ? null : (
              <section
                aria-labelledby={`group-${status}`}
                id={`plan-${status}`}
              >
                <GroupHeading
                  id={`group-${status}`}
                  count={model.gaps.groups[status].length}
                >
                  {t(GROUP_TITLES[status])}
                </GroupHeading>
                <ul class="flex flex-col gap-2">
                  {model.gaps.groups[status].map((entry) => (
                    <ItemCard
                      entry={entry}
                      gaps={model.gaps}
                      candidates={model.candidates.get(entry.item.id) ?? []}
                    />
                  ))}
                </ul>
              </section>
            ),
          )
        )}
      </main>
      {model.toast && (
        <SavedToast
          id="plan-toast"
          text={t(model.toast === 'created' ? 'plans.CREATED' : 'plans.SAVED')}
        />
      )}
      <StripFlags names={FLAGS} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

function GroupHeading(props: { id: string; count: number; children: string }) {
  return (
    <h2
      id={props.id}
      class="text-xs font-semibold uppercase tracking-wide text-base-content/50 mb-2"
    >
      {props.children} · {props.count}
    </h2>
  );
}

/**
 * Edit, Duplicate, Make active and Delete. The two posts are hidden forms
 * outside the menu that its buttons submit through their `form` attribute
 * (a form inside a daisyUI menu item loses the item's styling). In the
 * app bar's actions (layout/app-bar.tsx).
 */
function PlanMenu({ gaps }: { gaps: PlanGaps }) {
  const { plan } = gaps;
  return (
    <>
      <PostForm
        id="plan-duplicate"
        class="hidden"
        action={planUrl(plan.id, '/duplicate')}
        needsNetwork
      />
      <PostForm
        id="plan-activate"
        class="hidden"
        action={planUrl(plan.id, '/activate')}
        needsNetwork
      />
      <details class="dropdown dropdown-end">
        <summary
          class="btn btn-ghost btn-sm btn-circle text-xl"
          aria-label={t('plans.MORE')}
        >
          ⋯
        </summary>
        <ul class="menu dropdown-content bg-base-100 rounded-box shadow-lg z-20 w-52 p-2">
          <li>
            <a href={planUrl(plan.id, '/edit')}>{t('plans.EDIT_PLAN')}</a>
          </li>
          <li>
            <a href={compareUrl(plan.id)}>{t('shopping.COMPARE_WITH')}</a>
          </li>
          <li>
            <button type="submit" form="plan-duplicate" data-needs-network>
              {t('plans.DUPLICATE')}
            </button>
          </li>
          {!plan.active && (
            <li>
              <button type="submit" form="plan-activate" data-needs-network>
                {t('plans.MAKE_ACTIVE')}
              </button>
            </li>
          )}
          <li>
            <button
              type="button"
              class="text-error"
              hx-delete={planUrl(plan.id)}
              hx-confirm={t('plans.CONFIRM_DELETE')}
              data-needs-network
            >
              {t('plans.DELETE_PLAN')}
            </button>
          </li>
        </ul>
      </details>
    </>
  );
}

/** The item's title, quantity, priority and budget: the head of every card. */
function ItemHead(props: {
  item: PlanItemRow;
  href: string;
  progress?: string;
}) {
  const { item } = props;
  return (
    <div class="flex items-start justify-between gap-2">
      <a
        href={props.href}
        class="font-medium link link-hover min-w-0 break-words"
      >
        {itemTitle(item)}
        {item.quantity > 1 && props.progress === undefined && (
          <span class="text-base-content/60"> ×{item.quantity}</span>
        )}
      </a>
      <span class="flex items-center gap-1 shrink-0">
        {props.progress && (
          <span class="text-sm font-medium">{props.progress}</span>
        )}
        {item.priority !== 'medium' && (
          <span
            class={`badge badge-sm ${item.priority === 'high' ? 'badge-warning' : 'badge-ghost'}`}
          >
            {priorityLabel(item.priority)}
          </span>
        )}
      </span>
    </div>
  );
}

function ItemBody({ item }: { item: PlanItemRow }) {
  const facts = itemFacts(item);
  return (
    <>
      {(facts.length > 0 || item.budget) && (
        <p class="text-xs text-base-content/60">
          {[
            ...facts,
            item.budget
              ? t('plans.BUDGET_EACH', { price: priceLabel(item.budget) })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {item.note && <p class="text-xs italic">{item.note}</p>}
    </>
  );
}

function ItemCard(props: {
  entry: GapItem;
  gaps: PlanGaps;
  candidates: CandidateGarment[];
}) {
  const { item, match } = props.entry;
  const { plan, closet } = props.gaps;
  const progress =
    match.status === 'partly'
      ? t('plans.HAVE_OF', { have: match.have, need: match.need })
      : undefined;
  return (
    <li
      class="card bg-base-100 shadow-sm"
      id={`plan-item-${item.id}`}
      data-status={match.status}
    >
      <div class="card-body p-3 gap-1">
        <ItemHead
          item={item}
          href={itemUrl(plan.id, item.id, '/edit')}
          progress={progress}
        />
        <ItemBody item={item} />
        {match.fulfilledBy.length > 0 && (
          <ul
            class="flex flex-wrap gap-1 mt-1"
            aria-label={t('plans.FULFILLED_BY')}
          >
            {match.fulfilledBy.map((fulfilment) => {
              const garment = closet.get(fulfilment.garmentId)!;
              return (
                <li>
                  <a
                    href={garmentUrl(garment.id, undefined)}
                    class="badge badge-outline badge-sm gap-1 h-auto py-0.5"
                  >
                    {garmentName(garment)}
                    {fulfilment.copies > 1 && ` ×${fulfilment.copies}`}
                    {fulfilment.needsRepair && (
                      <span class="text-warning">
                        · {t('plans.NEEDS_REPAIR')}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {match.reason && (
          <p
            class="text-xs text-base-content/70 mt-1"
            data-reason={match.reason}
          >
            {reasonText(match, props.gaps)}
          </p>
        )}
        {match.status !== 'owned' && (
          <Candidates item={item} candidates={props.candidates} />
        )}
      </div>
    </li>
  );
}

/**
 * A gap's candidate products (34b): each by name and price, and the link
 * to its candidates page ("Add a candidate" while it has none).
 */
function Candidates(props: {
  item: PlanItemRow;
  candidates: CandidateGarment[];
}) {
  const { item, candidates } = props;
  return (
    <p class="text-xs flex flex-wrap items-center gap-1 mt-1" data-candidates>
      {candidates.map((candidate) => (
        <a
          href={garmentUrl(candidate.garmentId, undefined)}
          class="badge badge-ghost badge-sm h-auto py-0.5"
        >
          {candidate.name ?? categoryLabel(candidate.category)}
          {candidate.price && ` · ${priceLabel(candidate.price)}`}
        </a>
      ))}
      <a href={candidatesUrl(item.planId, item.id)} class="link link-primary">
        {candidates.length === 0
          ? `+ ${t('shopping.ADD_CANDIDATE')}`
          : t('shopping.CANDIDATES_COUNT', { count: candidates.length })}
      </a>
    </p>
  );
}

function garmentName(garment: ClosetGarment): string {
  return garment.name ?? categoryLabel(garment.category);
}

/** Why an item is short, in words (ItemMatch.reason). */
function reasonText(match: ItemMatch, gaps: PlanGaps): string {
  const names = (ids: number[]) =>
    ids.map((id) => garmentName(gaps.closet.get(id)!)).join(', ');
  switch (match.reason) {
    case 'replace-soon':
      return t('plans.REASON_REPLACE_SOON', {
        names: names(match.replaceSoon),
      });
    case 'taken-by-other-items': {
      const items = new Map(
        [
          ...gaps.groups.owned,
          ...gaps.groups.partly,
          ...gaps.groups.missing,
        ].map(({ item }) => [item.id, item]),
      );
      return t('plans.REASON_TAKEN', {
        list: match.takenBy
          .map(
            (taker) =>
              `${names([taker.garmentId])} (${itemTitle(items.get(taker.itemId)!)})`,
          )
          .join(', '),
      });
    }
    case 'too-few-copies':
      return t('plans.REASON_TOO_FEW', { count: match.need - match.have });
    case 'nothing-matches':
      return t('plans.REASON_NOTHING');
    case null:
      return '';
  }
}

/** An item the agent proposed: what it is, and the owner's Accept or Dismiss. */
function ProposedCard({ item }: { item: PlanItemRow }) {
  return (
    <li
      class="card bg-base-100 shadow-sm border border-dashed border-primary/40"
      id={`plan-item-${item.id}`}
      data-status="proposed"
    >
      <div class="card-body p-3 gap-1">
        <ItemHead item={item} href={itemUrl(item.planId, item.id, '/edit')} />
        <ItemBody item={item} />
        <div class="flex gap-2 mt-2">
          <PostForm
            action={itemUrl(item.planId, item.id, '/accept')}
            class="flex-1"
            needsNetwork
          >
            <button type="submit" class="btn btn-sm btn-primary w-full">
              {t('plans.ACCEPT')}
            </button>
          </PostForm>
          <button
            type="button"
            class="btn btn-sm btn-ghost flex-1"
            hx-delete={itemUrl(item.planId, item.id)}
            data-needs-network
          >
            {t('plans.DISMISS')}
          </button>
        </div>
      </div>
    </li>
  );
}
