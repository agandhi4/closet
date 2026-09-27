import type { Child } from 'hono/jsx';
import type {
  ItemChange,
  ItemStatus,
  PlanComparison,
} from '../../wardrobe/plans';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, EmptyState } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { itemTitle, priorityLabel } from './labels';
import type { ComparedRow } from './compare';
import type { PlanDetail } from './queries';
import { COMPARE_PATH, PLANS_PATH, planUrl } from './urls';

export interface ComparePageModel {
  /** Every plan of the owner's, the choices of both pickers. */
  plans: PlanDetail[];
  /** The two plans compared; undefined with fewer than two plans. */
  pair?: {
    a: PlanDetail;
    b: PlanDetail;
    comparison: PlanComparison<ComparedRow>;
  };
}

const STATUS_BADGES: Record<ItemStatus, string> = {
  owned: 'badge-success',
  partly: 'badge-warning',
  missing: 'badge-error',
};

const STATUS_TITLES = {
  owned: 'plans.OWNED',
  partly: 'plans.PARTLY',
  missing: 'plans.MISSING',
} as const;

/**
 * GET /wardrobe/plans/compare?a=&b= (34b): two of the owner's plans side by
 * side, by item (comparePlans, src/wardrobe/plans.ts: the same kind is the
 * same category, type and colour set): what B adds, what it drops, what
 * both have but differently (how many, the priority, the details), and a
 * count of what is the same, each with how the closet answers it in its
 * plan (owned, partly, missing). The pickers are a plain GET form: the
 * choice lives in the URL. Proposals are left out: they are not part of a
 * plan until accepted.
 */
export function ComparePage(props: {
  ctx: ViewContext;
  model: ComparePageModel;
}) {
  const { ctx, model } = props;
  const { pair } = model;
  return (
    <Layout ctx={ctx} title={t('shopping.COMPARE_TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-4">
        <div class="flex items-center gap-3">
          <BackLink href={pair ? planUrl(pair.a.id) : PLANS_PATH} />
          <h1 class="text-2xl font-bold">{t('shopping.COMPARE_TITLE')}</h1>
        </div>
        {!pair ? (
          <EmptyState message={t('shopping.COMPARE_NEEDS_TWO')}>
            <a href={PLANS_PATH} class="btn btn-primary btn-sm">
              {t('plans.TITLE')}
            </a>
          </EmptyState>
        ) : (
          <>
            <form
              method="get"
              action={COMPARE_PATH}
              class="grid grid-cols-[1fr_1fr_auto] gap-2 items-end"
            >
              <PlanPicker
                name="a"
                label={t('shopping.COMPARE_A')}
                plans={model.plans}
                selected={pair.a.id}
              />
              <PlanPicker
                name="b"
                label={t('shopping.COMPARE_B')}
                plans={model.plans}
                selected={pair.b.id}
              />
              <button type="submit" class="btn btn-primary btn-sm">
                {t('shopping.COMPARE')}
              </button>
            </form>
            <Comparison pair={pair} />
          </>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function PlanPicker(props: {
  name: 'a' | 'b';
  label: string;
  plans: PlanDetail[];
  selected: number;
}) {
  const id = `compare-${props.name}`;
  return (
    <div class="flex flex-col min-w-0">
      <label class="label" for={id}>
        <span class="label-text text-xs">{props.label}</span>
      </label>
      <select
        id={id}
        name={props.name}
        class="select select-bordered select-sm w-full"
      >
        {props.plans.map((plan) => (
          <option value={String(plan.id)} selected={plan.id === props.selected}>
            {plan.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function Comparison({ pair }: { pair: NonNullable<ComparePageModel['pair']> }) {
  const { a, b, comparison } = pair;
  const changed = comparison.both.filter((entry) => entry.changes.length > 0);
  const same = comparison.both.filter((entry) => entry.changes.length === 0);
  return (
    <>
      <Group
        id="compare-added"
        title={t('shopping.ONLY_IN', { plan: b.name })}
        hint={t('shopping.ADDED_HINT', { a: a.name })}
        empty={t('shopping.NOTHING_ADDED')}
        rows={comparison.added.map((item) => (
          <ItemRow item={item} />
        ))}
      />
      <Group
        id="compare-dropped"
        title={t('shopping.ONLY_IN', { plan: a.name })}
        hint={t('shopping.DROPPED_HINT', { b: b.name })}
        empty={t('shopping.NOTHING_DROPPED')}
        rows={comparison.dropped.map((item) => (
          <ItemRow item={item} />
        ))}
      />
      <Group
        id="compare-changed"
        title={t('shopping.CHANGED')}
        empty={t('shopping.NOTHING_CHANGED')}
        rows={changed.map((entry) => (
          <ItemRow item={entry.b} before={entry.a} changes={entry.changes} />
        ))}
      />
      {same.length > 0 && (
        <details id="compare-same">
          <summary class="text-xs font-semibold uppercase tracking-wide text-base-content/50 cursor-pointer">
            {t('shopping.SAME', { count: same.length })}
          </summary>
          <ul class="flex flex-col gap-1 mt-2">
            {same.map((entry) => (
              <ItemRow item={entry.b} before={entry.a} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Group(props: {
  id: string;
  title: string;
  hint?: string;
  empty: string;
  rows: Child[];
}) {
  return (
    <section id={props.id} aria-labelledby={`${props.id}-title`}>
      <h2
        id={`${props.id}-title`}
        class="text-xs font-semibold uppercase tracking-wide text-base-content/50"
      >
        {props.title} · {props.rows.length}
      </h2>
      {props.hint && (
        <p class="text-xs text-base-content/60 mb-1">{props.hint}</p>
      )}
      {props.rows.length === 0 ? (
        <p class="text-sm text-base-content/60">{props.empty}</p>
      ) : (
        <ul class="flex flex-col gap-1 mt-1">{props.rows}</ul>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <span
      class={`badge badge-sm ${STATUS_BADGES[status]}`}
      data-status={status}
    >
      {t(STATUS_TITLES[status])}
    </span>
  );
}

/** What changed between an item and its counterpart, in words. */
function changeText(
  change: ItemChange,
  before: ComparedRow,
  after: ComparedRow,
): string {
  switch (change) {
    case 'quantity':
      return t('shopping.CHANGE_QUANTITY', {
        a: before.quantity,
        b: after.quantity,
      });
    case 'priority':
      return t('shopping.CHANGE_PRIORITY', {
        a: priorityLabel(before.priority),
        b: priorityLabel(after.priority),
      });
    case 'details':
      return t('shopping.CHANGE_DETAILS');
  }
}

/**
 * An item: its title and quantity, and how the closet answers it (in its
 * plan; for a pair, in A and then B when they differ).
 */
function ItemRow(props: {
  item: ComparedRow;
  before?: ComparedRow;
  changes?: ItemChange[];
}) {
  const { item, before, changes = [] } = props;
  return (
    <li
      class="flex flex-wrap items-center gap-2 text-sm bg-base-100 rounded-box px-3 py-2 shadow-sm"
      data-item={item.row.id}
    >
      <span class="flex-1 min-w-0 break-words">
        {itemTitle(item.row)}
        {item.quantity > 1 && changes.length === 0 && (
          <span class="text-base-content/60"> ×{item.quantity}</span>
        )}
      </span>
      {changes.length > 0 && before && (
        <span
          class="text-xs text-base-content/70"
          data-changes={changes.join(' ')}
        >
          {changes
            .map((change) => changeText(change, before, item))
            .join(' · ')}
        </span>
      )}
      <span class="flex items-center gap-1 shrink-0">
        {before && before.status !== item.status && (
          <>
            <StatusBadge status={before.status} />
            <span aria-hidden="true">→</span>
          </>
        )}
        <StatusBadge status={item.status} />
      </span>
    </li>
  );
}
