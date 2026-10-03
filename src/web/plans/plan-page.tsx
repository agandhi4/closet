import { type RoleGroup, topToToe } from '../../wardrobe/generator';
import type { ItemMatch, ItemStatus } from '../../wardrobe/plans';
import { rankCandidates } from '../../wardrobe/shopping';
import { PostForm } from '../auth/form';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { HangerIcon, SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { roleGroupLabel } from '../wardrobe/labels';
import { garmentUrl } from '../wardrobe/urls';
import { candidateName, isAgentsPick } from './candidate-tile';
import type { CandidatesByItem } from './candidates';
import { byPriority, type PlanGaps } from './gaps';
import { itemTitle, priorityLabel } from './labels';
import type { ClosetGarment, PlanItemRow } from './queries';
import { type ListedCandidate, listedCandidate } from './shopping';
import {
  candidatesUrl,
  compareUrl,
  itemUrl,
  planUrl,
  PLANS_PATH,
  reviewUrl,
  shoppingUrl,
} from './urls';

export interface PlanPageModel {
  gaps: PlanGaps;
  /** Each item's candidate products (34b): wishlist garments, by item id. */
  candidates: CandidatesByItem;
  /** The one-shot toast after a write (PlanPageQuery). */
  toast?: 'created' | 'saved' | 'reviewed';
  /** With the review's toast: the products it removed from the wishlist. */
  removed?: number;
}

/** The toast's text: the review's names the products it removed, if any. */
function toastText(
  toast: NonNullable<PlanPageModel['toast']>,
  removed: number | undefined,
): string {
  if (removed === undefined) return t(TOASTS[toast]);
  return removed === 1
    ? t('plans.REVIEWED_REMOVED_ONE')
    : t('plans.REVIEWED_REMOVED_MANY', { count: removed });
}

/** The page's one-shot flags, stripped from the address once shown. */
const FLAGS = ['created', 'saved', 'reviewed', 'removed'] as const;

const TOASTS = {
  created: 'plans.CREATED',
  saved: 'plans.SAVED',
  reviewed: 'plans.REVIEWED',
} as const;

/**
 * Where an item stands, as its card's chip says it: a proposal or one sent
 * back to the agent (#278), else how the closet answers it. A declined item
 * has no card (it is listed apart, below the sections).
 */
export type CardStatus = 'proposed' | 'revise' | ItemStatus;

/** An item's card: the item, where it stands, and its products. */
export interface PlanCard {
  item: PlanItemRow;
  status: CardStatus;
  /** How the closet answers it: accepted items only. */
  match?: ItemMatch;
  /** Its candidate products, the likeliest bought first (rankCandidates). */
  candidates: ListedCandidate[];
}

/**
 * Within a section, what asks for a decision first (the proposals, then
 * what waits on the agent), then the gaps before what is owned: the gap
 * view's order.
 */
const STATUS_ORDER: readonly CardStatus[] = [
  'proposed',
  'revise',
  'missing',
  'partly',
  'owned',
];

/**
 * The plan's items as cards in sections by role, top to toe (#295: the
 * owner could not tell what each thing was in one flat list), each section
 * in STATUS_ORDER, then priority. Declined items are left out: they are not
 * part of the plan, and are listed apart.
 */
export function planSections(
  gaps: PlanGaps,
  candidates: CandidatesByItem,
): RoleGroup<PlanCard>[] {
  const ranked = (item: PlanItemRow) =>
    rankCandidates(
      item,
      (candidates.get(item.id) ?? []).map((candidate) =>
        listedCandidate(item, candidate),
      ),
    ).map(({ candidate }) => candidate);
  const cards: PlanCard[] = [
    ...gaps.review.proposed.map((item) => ({
      item,
      status: 'proposed' as const,
      candidates: ranked(item),
    })),
    ...gaps.review.revise.map((item) => ({
      item,
      status: 'revise' as const,
      candidates: ranked(item),
    })),
    ...(['missing', 'partly', 'owned'] as const).flatMap((status) =>
      gaps.groups[status].map(({ item, match }) => ({
        item,
        status,
        match,
        candidates: ranked(item),
      })),
    ),
  ];
  cards.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      byPriority(a.item, b.item),
  );
  return topToToe(cards, (card) => card.item.category);
}

/**
 * GET /wardrobe/plans/:id, the plan (#34, slice 34a; drawn as a lookbook
 * in #295): its items as cards in sections by role, top to toe, as the
 * Wardrobe's grid draws garments. Each card is a photo (its likeliest
 * product, or for an owned item the closet garment that fulfils it; the
 * garment glyph until there is one), the item in words, its budget, its
 * options and a chip saying where it stands: to review, with your agent,
 * to buy, partly owned, owned. The status is a chip, not a grouping: at
 * 390 px a status grouping split each category into up to five places, and
 * what the owner asked first was what each thing is. The agent's proposals
 * are counted above with Review (#271), and each keeps Accept, Change
 * this… and Don't buy (#278); declined items are listed apart with
 * Reconsider. A plan an agent drafted (create_plan) names its token.
 * Private: the signed-in owner's plan and closet only.
 */
export function PlanPage(props: { ctx: ViewContext; model: PlanPageModel }) {
  const { ctx, model } = props;
  const { plan, tally } = model.gaps;
  const { proposed, declined } = model.gaps.review;
  const sections = planSections(model.gaps, model.candidates);
  return (
    <Layout ctx={ctx} title={plan.name}>
      <AppBar
        ctx={ctx}
        title={plan.name}
        back={PLANS_PATH}
        actions={<PlanMenu gaps={model.gaps} />}
      />
      <main class="p-4 pt-20 pb-24 w-full sm:max-w-lg sm:mx-auto flex flex-col gap-5">
        <div class="flex flex-col gap-1">
          <p class="text-sm text-muted" id="plan-tally">
            {plan.active && (
              <span class="badge badge-primary badge-sm mr-2">
                {t('plans.ACTIVE')}
              </span>
            )}
            {t('plans.TALLY', tally)}
          </p>
          {plan.draftedBy !== null && (
            <p class="text-sm text-muted" id="plan-drafted-by">
              {t('plans.DRAFTED_BY', { name: plan.draftedBy })}
            </p>
          )}
          {plan.notes && (
            <p class="text-sm whitespace-pre-line text-base-content/80">
              {plan.notes}
            </p>
          )}
        </div>
        {proposed.length > 0 && (
          <div
            class="flex items-center justify-between gap-3 rounded-box bg-base-200 px-3 py-2"
            id="plan-proposals"
          >
            <p class="text-sm">
              {t('plans.PROPOSED_COUNT', { count: proposed.length })}
            </p>
            <a
              href={reviewUrl(plan.id)}
              class="btn btn-primary btn-sm shrink-0"
              id="plan-review"
            >
              {t('plans.REVIEW')}
            </a>
          </div>
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

        {sections.length === 0 && declined.length === 0 ? (
          <p class="text-sm text-muted text-center pt-8">
            {t('plans.NO_ITEMS')}
          </p>
        ) : (
          sections.map((section) => (
            <RoleSection section={section} gaps={model.gaps} />
          ))
        )}
        {declined.length > 0 && <DeclinedList items={declined} />}
      </main>
      {model.toast && (
        <SavedToast
          id="plan-toast"
          text={toastText(model.toast, model.removed)}
        />
      )}
      <StripFlags names={FLAGS} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** A role's cards under its heading and count: "Shoes · 2". */
function RoleSection(props: { section: RoleGroup<PlanCard>; gaps: PlanGaps }) {
  const { role, items } = props.section;
  return (
    <section
      aria-labelledby={`plan-role-${role}-title`}
      id={`plan-role-${role}`}
      data-role={role}
    >
      <h2 id={`plan-role-${role}-title`} class="font-semibold mb-2">
        {roleGroupLabel(role)}{' '}
        <span class="font-normal text-muted">· {items.length}</span>
      </h2>
      <ul class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3">
        {items.map((card) => (
          <ItemCard card={card} gaps={props.gaps} />
        ))}
      </ul>
    </section>
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
        <ul class="menu dropdown-content bg-base-100 rounded-box border border-base-300 z-20 w-52 p-2">
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

/** The chip on a card's photo: where the item stands. */
function statusChip(card: PlanCard): { text: string; class: string } {
  switch (card.status) {
    case 'proposed':
      return { text: t('plans.status.proposed'), class: 'badge-primary' };
    case 'revise':
      return { text: t('plans.status.revise'), class: 'badge-info' };
    case 'missing':
      return { text: t('plans.status.missing'), class: 'badge-warning' };
    case 'partly':
      return {
        text: t('plans.HAVE_OF', {
          have: card.match!.have,
          need: card.match!.need,
        }),
        class: 'badge-warning badge-outline bg-base-100',
      };
    case 'owned':
      return { text: t('plans.status.owned'), class: 'badge-success' };
  }
}

/** The photo a card leads with, what it is of, and which product when it is one. */
interface Lead {
  photo: SignablePhotoRef;
  name: string;
  /** The candidate on the photo, left out of the thumbs under it. */
  candidateId?: number;
}

/**
 * The photo a card leads with: for an item the closet answers, the first
 * garment fulfilling it that has a photo; else, while it is still to buy,
 * its likeliest product with one. Null: the garment glyph.
 */
function leadOf(
  card: PlanCard,
  closet: Map<number, ClosetGarment>,
): Lead | null {
  const owned = (card.match?.fulfilledBy ?? [])
    .map(({ garmentId }) => closet.get(garmentId)!)
    .find((garment) => garment.photo !== null);
  if (owned) return { photo: owned.photo!, name: garmentName(owned) };
  if (card.status === 'owned') return null;
  const product = card.candidates.find((candidate) => candidate.photo !== null);
  return product
    ? {
        photo: product.photo!,
        name: candidateName(product),
        candidateId: product.garmentId,
      }
    : null;
}

/**
 * An item's card, the Wardrobe tile's language (the plinth, 4:5, its marks
 * small over the corners, the words under it): the photo with its status
 * chip and copies, the item in words (a stretched link to its edit form),
 * the budget and priority, then its options while it is still to buy (the
 * other products as small thumbs and their count, a link to its candidates
 * page; "No options yet" and Add a product while it has none), what in the
 * closet fulfils it, the owner's note to the agent, and its review moves.
 * The links and buttons over the stretched link are `relative z-10`.
 */
function ItemCard(props: { card: PlanCard; gaps: PlanGaps }) {
  const { card, gaps } = props;
  const { item, match } = card;
  const chip = statusChip(card);
  const lead = leadOf(card, gaps.closet);
  const meta = [
    item.budget
      ? t('plans.BUDGET_EACH', { price: priceLabel(item.budget) })
      : null,
    item.priority === 'medium'
      ? null
      : t('plans.PRIORITY_BADGE', { priority: priorityLabel(item.priority) }),
  ].filter((part) => part !== null);
  return (
    <li
      id={`plan-item-${item.id}`}
      data-status={card.status}
      class="relative flex min-w-0 flex-col gap-1"
    >
      <figure class="relative aspect-[4/5] overflow-hidden rounded-box bg-base-200 flex items-center justify-center">
        {lead ? (
          <img
            src={imageUrl(lead.photo, 'thumb')}
            alt={lead.name}
            class="size-full object-contain p-2"
            width="400"
            height="400"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <HangerIcon class="size-1/3 text-faint" strokeWidth="1" />
        )}
        <span
          class={`badge badge-sm absolute top-1.5 left-1.5 ${chip.class}`}
          data-status-chip=""
        >
          {chip.text}
        </span>
        {card.status !== 'owned' && card.candidates.some(isAgentsPick) && (
          <span
            class="badge badge-xs badge-primary absolute bottom-1.5 right-1.5"
            data-agents-pick=""
          >
            {t('plans.AGENTS_PICK')}
          </span>
        )}
        {item.quantity > 1 && (
          <span class="badge badge-xs badge-neutral absolute bottom-1.5 left-1.5">
            {t('QUANTITY_BADGE', { quantity: item.quantity })}
          </span>
        )}
      </figure>
      <a
        href={itemUrl(item.planId, item.id, '/edit')}
        class="text-sm font-medium leading-snug line-clamp-2 break-words after:absolute after:inset-0"
      >
        {itemTitle(item)}
      </a>
      {meta.length > 0 && <p class="text-xs text-muted">{meta.join(' · ')}</p>}
      {card.status !== 'owned' && (
        <Options card={card} onPhoto={lead?.candidateId} />
      )}
      {match && match.fulfilledBy.length > 0 && (
        <FulfilledBy match={match} closet={gaps.closet} />
      )}
      {match?.reason && match.reason !== 'nothing-matches' && (
        <p class="text-xs text-muted" data-reason={match.reason}>
          {reasonText(match, gaps)}
        </p>
      )}
      {item.ownerNote && (
        <p class="text-xs line-clamp-3" data-owner-note>
          {t('plans.YOUR_NOTE', { note: item.ownerNote })}
        </p>
      )}
      <ReviewMoves item={item} status={card.status} />
    </li>
  );
}

/** Thumbs of the products a card does not lead with: a few, then the count says the rest. */
const OPTION_THUMBS = 3;

/**
 * An item's options (its candidate products, 34b): the products but the
 * one its photo shows (`onPhoto`) as small thumbs, each a link to its
 * wishlist page, and "3 options", a link to the candidates page; while it
 * has none, "No options yet" and Add a product.
 */
function Options(props: { card: PlanCard; onPhoto: number | undefined }) {
  const { item, candidates } = props.card;
  const href = candidatesUrl(item.planId, item.id);
  if (candidates.length === 0) {
    return (
      <p
        class="relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
        data-candidates=""
      >
        <span class="badge badge-ghost badge-sm" data-no-options="">
          {t('plans.NO_OPTIONS')}
        </span>
        <a href={href} class="link link-primary">
          + {t('shopping.ADD_PRODUCT')}
        </a>
      </p>
    );
  }
  const others = candidates
    .filter((candidate) => candidate.garmentId !== props.onPhoto)
    .slice(0, OPTION_THUMBS);
  return (
    <div
      class="relative z-10 flex items-center gap-1.5 text-xs"
      data-candidates=""
    >
      {others.map((candidate) => (
        <a
          href={garmentUrl(candidate.garmentId, undefined)}
          class="size-8 shrink-0 overflow-hidden rounded-field bg-base-200 flex items-center justify-center"
          aria-label={candidateName(candidate)}
        >
          {candidate.photo ? (
            <img
              src={imageUrl(candidate.photo, 'thumb')}
              alt=""
              class="size-full object-contain p-0.5"
              width="64"
              height="64"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <HangerIcon class="size-4 text-faint" strokeWidth="1.5" />
          )}
        </a>
      ))}
      <a href={href} class="link link-hover text-muted whitespace-nowrap">
        {candidates.length === 1
          ? t('plans.OPTIONS_ONE')
          : t('plans.OPTIONS', { count: candidates.length })}
      </a>
    </div>
  );
}

/** What in the closet fulfils an item: "In your closet: White tee ×2". */
function FulfilledBy(props: {
  match: ItemMatch;
  closet: Map<number, ClosetGarment>;
}) {
  return (
    <p class="relative z-10 text-xs text-muted line-clamp-2">
      {t('plans.FULFILLED_BY')}:{' '}
      {props.match.fulfilledBy.map((fulfilment, index) => {
        const garment = props.closet.get(fulfilment.garmentId)!;
        return (
          <>
            {index > 0 && ', '}
            <a
              href={garmentUrl(garment.id, undefined)}
              class="link link-hover text-base-content"
            >
              {garmentName(garment)}
            </a>
            {fulfilment.copies > 1 && ` ×${fulfilment.copies}`}
            {fulfilment.needsRepair && (
              <span class="text-warning"> ({t('plans.NEEDS_REPAIR')})</span>
            )}
          </>
        );
      })}
    </p>
  );
}

/**
 * An item's own review moves (#278), each its own small native post (no
 * swipe state to keep here, unlike the review page): a proposal's Accept,
 * Change this… and Don't buy; one sent back for a change, Accept as it is
 * and Don't buy; an accepted one, Change this….
 */
function ReviewMoves(props: { item: PlanItemRow; status: CardStatus }) {
  const { item, status } = props;
  const action = (suffix: string) => itemUrl(item.planId, item.id, suffix);
  const change = (
    <a
      href={action('/change')}
      class="link link-hover text-xs text-muted self-start"
    >
      {t('plans.CHANGE_THIS')}
    </a>
  );
  if (status !== 'proposed' && status !== 'revise') {
    return <div class="relative z-10 flex">{change}</div>;
  }
  return (
    <div class="relative z-10 mt-1 flex flex-col gap-1">
      <div class="flex flex-wrap gap-1">
        <PostForm action={action('/accept')} needsNetwork>
          <button type="submit" class="btn btn-xs btn-primary">
            {t(status === 'revise' ? 'plans.ACCEPT_AS_IS' : 'plans.ACCEPT')}
          </button>
        </PostForm>
        <PostForm action={action('/decline')} needsNetwork>
          <button type="submit" class="btn btn-xs btn-ghost">
            {t('plans.DONT_BUY')}
          </button>
        </PostForm>
      </div>
      {status === 'proposed' && change}
    </div>
  );
}

/**
 * The declined items ("Don't buy"), apart from the sections: not part of
 * the plan, kept so the agent never proposes them again. Each with the
 * owner's note, if any, and Reconsider.
 */
function DeclinedList({ items }: { items: PlanItemRow[] }) {
  return (
    <section aria-labelledby="plan-declined-title" id="plan-declined">
      <h2 id="plan-declined-title" class="font-semibold">
        {t('plans.DECLINED')}{' '}
        <span class="font-normal text-muted">· {items.length}</span>
      </h2>
      <p class="text-xs text-muted mb-2">{t('plans.DECLINED_HINT')}</p>
      <ul class="flex flex-col divide-y divide-base-300">
        {items.map((item) => (
          <li
            id={`plan-item-${item.id}`}
            data-status="declined"
            class="flex items-center justify-between gap-3 py-2"
          >
            <div class="min-w-0">
              <a
                href={itemUrl(item.planId, item.id, '/edit')}
                class="text-sm link link-hover break-words"
              >
                {itemTitle(item)}
              </a>
              {item.ownerNote && (
                <p class="text-xs text-muted" data-owner-note>
                  {t('plans.YOUR_NOTE', { note: item.ownerNote })}
                </p>
              )}
            </div>
            <PostForm
              action={itemUrl(item.planId, item.id, '/reconsider')}
              needsNetwork
            >
              <button type="submit" class="btn btn-xs btn-outline">
                {t('plans.RECONSIDER')}
              </button>
            </PostForm>
          </li>
        ))}
      </ul>
    </section>
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
