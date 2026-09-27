import type { ItemMatch, ItemStatus } from '../../wardrobe/plans';
import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import type { GapItem, PlanGaps } from './gaps';
import { itemFacts, itemTitle, priorityLabel } from './labels';
import type { ClosetGarment, PlanItemRow } from './queries';
import { itemUrl, planUrl, PLANS_PATH } from './urls';

export interface PlanPageModel {
  gaps: PlanGaps;
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
 * and closet only. 34b hangs the shopping list off the missing group
 * (candidate wishlist garments per item, within its budget).
 */
export function PlanPage(props: { ctx: ViewContext; model: PlanPageModel }) {
  const { ctx, model } = props;
  const { plan, tally, proposed } = model.gaps;
  return (
    <Layout ctx={ctx} title={plan.name}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-5">
        <div class="flex items-start gap-3">
          <BackLink href={PLANS_PATH} />
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-bold break-words">{plan.name}</h1>
            <p class="text-sm text-base-content/60" id="plan-tally">
              {plan.active && (
                <span class="badge badge-primary badge-sm mr-2">
                  {t('plans.ACTIVE')}
                </span>
              )}
              {t('plans.TALLY', tally)}
            </p>
          </div>
          <PlanMenu gaps={model.gaps} />
        </div>
        {plan.notes && (
          <p class="text-sm whitespace-pre-line text-base-content/80">
            {plan.notes}
          </p>
        )}
        <a href={itemUrl(plan.id, 'new')} class="btn btn-primary w-full">
          + {t('plans.ADD_ITEM')}
        </a>

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
                    <ItemCard entry={entry} gaps={model.gaps} />
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
 * (a form inside a daisyUI menu item loses the item's styling; the
 * navbar's sign-out does the same).
 */
function PlanMenu({ gaps }: { gaps: PlanGaps }) {
  const { plan } = gaps;
  return (
    <>
      <PostForm
        id="plan-duplicate"
        action={planUrl(plan.id, '/duplicate')}
        needsNetwork
      />
      <PostForm
        id="plan-activate"
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

function ItemCard(props: { entry: GapItem; gaps: PlanGaps }) {
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
      </div>
    </li>
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
