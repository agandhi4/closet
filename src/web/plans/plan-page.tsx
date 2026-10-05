import { type RoleGroup, topToToe } from '../../wardrobe/generator';
import type { ItemMatch, ItemStatus } from '../../wardrobe/plans';
import { rankCandidates } from '../../wardrobe/shopping';
import { PostForm } from '../auth/form';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import {
  enlargeLabel,
  PhotoSet,
  viewerTrigger,
  type ViewerPhoto,
} from '../files/photo-viewer';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import { HangerIcon, SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { roleGroupLabel } from '../wardrobe/labels';
import { garmentUrl } from '../wardrobe/urls';
import { candidateName, isAgentsPick } from './candidate-tile';
import type { CandidatesByItem } from './candidates';
import { awaitingReview, byPriority, type PlanGaps } from './gaps';
import { itemTitle, priorityLabel } from './labels';
import { PlanLookCards } from './look-cards';
import type { LookGroups } from './looks';
import type { ClosetGarment, PlanItemRow } from './queries';
import { type ListedCandidate, listedCandidate } from './shopping';
import {
  candidatesUrl,
  compareUrl,
  itemUrl,
  planUrl,
  PLANS_PATH,
  PLAN_VIEWS,
  type PlanView,
  reviewUrl,
  shoppingUrl,
} from './urls';

export interface PlanPageModel {
  gaps: PlanGaps;
  /** Each item's candidate products (34b): wishlist garments, by item id. */
  candidates: CandidatesByItem;
  /** The plan's looks (#291), grouped for the page. */
  looks: LookGroups;
  /** Which view of the plan the page draws (`?view=`, planView). */
  view: PlanView;
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

/** `?view=`: Outfits when asked for it, else Items (URL state falls back, never a 400). */
export function planView(raw: string | undefined): PlanView {
  return PLAN_VIEWS.find((view) => view === raw) ?? 'items';
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
 * Reconsider. A plan an agent drafted (create_plan) names its token. Its
 * looks (#291) are the Outfits view's large cards (look-cards.tsx, #314).
 * Private: the signed-in owner's plan and
 * closet only.
 */
export function PlanPage(props: { ctx: ViewContext; model: PlanPageModel }) {
  const { ctx, model } = props;
  const { plan } = model.gaps;
  const { declined } = model.gaps.review;
  const awaiting = awaitingReview(model.gaps);
  const sections = planSections(model.gaps, model.candidates);
  const { looks } = model;
  return (
    <Layout ctx={ctx} title={plan.name}>
      <AppBar
        ctx={ctx}
        title={plan.name}
        back={PLANS_PATH}
        actions={<PlanMenu gaps={model.gaps} />}
      />
      <PageMain width="wide" class="p-4 pt-20 pb-24 flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <PlanTally gaps={model.gaps} />
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
        {awaiting > 0 && (
          <div
            class="flex items-center justify-between gap-3 rounded-box bg-base-200 px-3 py-2"
            id="plan-proposals"
          >
            <p class="text-sm">
              {t('plans.PROPOSED_COUNT', { count: awaiting })}
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
        <div class={`flex flex-col gap-4 ${PLAN_VIEW_PANELS}`}>
          <div class="flex items-center justify-between gap-2">
            <PlanViewTabs
              view={model.view}
              items={
                sections.reduce((sum, { items }) => sum + items.length, 0) +
                declined.length
              }
              outfits={
                looks.strip.length + looks.revise.length + looks.declined.length
              }
            />
            <a href={itemUrl(plan.id, 'new')} class="btn btn-primary btn-sm">
              + {t('plans.ADD_ITEM')}
            </a>
          </div>

          <div id="plan-panel-outfits" class="space-y-4">
            <PlanLookCards looks={looks} />
          </div>
          <div id="plan-panel-items" class="space-y-4">
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
          </div>
        </div>
      </PageMain>
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

/**
 * The header's one tally line: the Active badge, and where the accepted
 * items stand. A draft whose items are all still proposals has nothing to
 * tally ("0 owned · 0 partly · 0 missing" read like a bug): the proposals
 * banner under it says what waits.
 */
function PlanTally({ gaps }: { gaps: PlanGaps }) {
  const { plan, tally } = gaps;
  const accepted = tally.owned + tally.partly + tally.missing;
  const tallied = accepted > 0 || awaitingReview(gaps) === 0;
  if (!plan.active && !tallied) return null;
  return (
    <p class="text-sm text-muted" id="plan-tally">
      {plan.active && (
        <span class={`badge badge-primary badge-sm ${tallied ? 'mr-2' : ''}`}>
          {t('plans.ACTIVE')}
        </span>
      )}
      {tallied && t('plans.TALLY', tally)}
    </p>
  );
}

/**
 * Items and Outfits: daisyUI radio tabs, so a switch is local (the page
 * holds both panels; `PLAN_VIEW_PANELS` shows the checked one) and works
 * offline: `?view=` is a separate cache key, so a link per tab would fall to
 * the offline page. `?view=` only picks the initially checked tab. Radios are
 * keyboard operable (arrows) and the checked one is the selected tab.
 */
function PlanViewTabs(props: {
  view: PlanView;
  items: number;
  outfits: number;
}) {
  const counts = { items: props.items, outfits: props.outfits };
  // What the number counts: both panels' every entry, collapsed sections too.
  const titles = {
    items: t('plans.VIEW_ITEMS_COUNTS'),
    outfits: t('plans.VIEW_OUTFITS_COUNTS'),
  };
  const labels = {
    items: t('plans.VIEW_ITEMS'),
    outfits: t('plans.VIEW_OUTFITS'),
  };
  return (
    <div
      role="radiogroup"
      aria-label={t('plans.VIEWS')}
      class="tabs tabs-border"
      id="plan-views"
    >
      {PLAN_VIEWS.map((view) => (
        <input
          type="radio"
          name="plan-view"
          id={`plan-view-${view}`}
          class="tab"
          aria-label={`${labels[view]} ${counts[view]}`}
          title={titles[view]}
          data-view={view}
          checked={props.view === view}
        />
      ))}
    </div>
  );
}

/**
 * Shows the panel of the checked tab, hides the other; the wrapper holds the
 * tabs and both panels. Written whole so Tailwind sees the classes.
 */
const PLAN_VIEW_PANELS =
  '[&:has(#plan-view-items:checked)_#plan-panel-outfits]:hidden [&:has(#plan-view-outfits:checked)_#plan-panel-items]:hidden';

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
      <ul class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
          {gaps.tally.missing + gaps.tally.partly > 0 && (
            <li>
              <a href={shoppingUrl(plan)}>{t('shopping.TITLE')}</a>
            </li>
          )}
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
 * What a card says of the item in one line: "Owned", "To buy · $90" (the
 * price of the product on its photo), "2 of 3", or the review's own words. The rest
 * (budget, priority, what in the closet fulfils it) is in its sheet.
 */
function statusLine(card: PlanCard, lead: Lead | null): string {
  switch (card.status) {
    case 'partly':
      return t('plans.HAVE_OF', {
        have: card.match!.have,
        need: card.match!.need,
      });
    case 'missing': {
      // The price of the product on the photo; with no photo, the top one's.
      const shown = lead
        ? card.candidates.find(
            ({ garmentId }) => garmentId === lead.candidateId,
          )
        : card.candidates[0];
      const price = shown?.price;
      return price
        ? t('plans.TO_BUY_PRICE', { price: priceLabel(price) })
        : t('plans.status.missing');
    }
    case 'proposed':
    case 'revise':
    case 'owned':
      return t(`plans.status.${card.status}`);
  }
}

/**
 * What the photo viewer swipes through for an item (#313): the closet
 * garments fulfilling it, then its products, those with a photo. The lead
 * is always one of them.
 */
function viewerPhotos(
  card: PlanCard,
  closet: Map<number, ClosetGarment>,
): ViewerPhoto[] {
  const owned = (card.match?.fulfilledBy ?? [])
    .map(({ garmentId }) => closet.get(garmentId)!)
    .filter((garment) => garment.photo !== null)
    .map((garment) => ({ photo: garment.photo!, alt: garmentName(garment) }));
  const products =
    card.status === 'owned'
      ? []
      : card.candidates
          .filter((candidate) => candidate.photo !== null)
          .map((candidate) => ({
            photo: candidate.photo!,
            alt: candidateName(candidate),
          }));
  return [...owned, ...products];
}

const viewerSetId = (card: PlanCard) => `plan-item-${card.item.id}-photos`;

/** The photo, or the garment glyph while there is none. */
function LeadPhoto(props: { lead: Lead | null }) {
  const { lead } = props;
  return lead ? (
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
  );
}

/**
 * An item's card, the Wardrobe tile's language (the plinth, 4:5): a big
 * photo, the item in words and one status line, the whole card a button
 * that opens the item's sheet (ItemSheet; native `showModal`, the page's
 * other sheets' way). The photo is the closet garment that fulfils it, else
 * its likeliest product, else the glyph; copies wanted sit on it small.
 */
function ItemCard(props: { card: PlanCard; gaps: PlanGaps }) {
  const { card, gaps } = props;
  const { item } = card;
  const lead = leadOf(card, gaps.closet);
  return (
    <li
      id={`plan-item-${item.id}`}
      data-status={card.status}
      class="relative flex min-w-0 flex-col"
    >
      <button
        type="button"
        class="flex min-w-0 flex-col gap-1 text-left"
        aria-haspopup="dialog"
        onclick="this.closest('li').querySelector('dialog').showModal()"
      >
        <span class="relative aspect-[4/5] w-full overflow-hidden rounded-box bg-base-200 flex items-center justify-center">
          <LeadPhoto lead={lead} />
          {item.quantity > 1 && (
            <span class="badge badge-xs badge-neutral absolute bottom-1.5 left-1.5">
              {t('QUANTITY_BADGE', { quantity: item.quantity })}
            </span>
          )}
        </span>
        <span class="text-sm font-medium leading-snug line-clamp-2 break-words">
          {itemTitle(item)}
        </span>
        <span class="text-xs text-muted" data-status-line="">
          {statusLine(card, lead)}
        </span>
      </button>
      {lead && (
        <>
          <PhotoSet
            id={viewerSetId(card)}
            photos={viewerPhotos(card, gaps.closet)}
          />
          {/* A sibling of the card's button, never inside it: the card opens
              the sheet, this opens the photo viewer. */}
          <button
            type="button"
            class="absolute right-0 top-0 z-10 flex size-11 items-center justify-center"
            aria-label={enlargeLabel(lead.name)}
            {...viewerTrigger(viewerSetId(card), lead.photo)}
          >
            {/* The visible disc stays small; the button around it is the 44 px target. */}
            <span class="btn btn-circle btn-xs btn-neutral opacity-80 pointer-events-none">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2"
                stroke="currentColor"
                class="size-3.5"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
                />
              </svg>
            </span>
          </button>
        </>
      )}
      <ItemSheet card={card} gaps={gaps} lead={lead} />
    </li>
  );
}

/**
 * An item's sheet, opened from its card: what the card used to carry (the
 * status chip, budget and priority, what in the closet fulfils it, the
 * owner's note, the options and Add a product, the review moves and Change
 * this...) and the edit form's link, each through its existing route.
 */
function ItemSheet(props: {
  card: PlanCard;
  gaps: PlanGaps;
  lead: Lead | null;
}) {
  const { card, gaps, lead } = props;
  const { item } = card;
  const titleId = `plan-sheet-${item.id}-title`;
  return (
    <dialog
      id={`plan-sheet-${item.id}`}
      class="modal modal-bottom sm:modal-middle"
      aria-labelledby={titleId}
    >
      <div class="modal-box flex flex-col gap-3 pb-8">
        <SheetHeader card={card} lead={lead} titleId={titleId} />
        <SheetBody card={card} gaps={gaps} lead={lead} />
        <div class="modal-action mt-2 items-center">
          <a
            href={itemUrl(item.planId, item.id, '/edit')}
            class="btn btn-outline btn-sm"
          >
            {t('plans.EDIT_ITEM')}
          </a>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onclick="this.closest('dialog').close()"
          >
            {t('CLOSE')}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>{t('CLOSE')}</button>
      </form>
    </dialog>
  );
}

/** The sheet's top: photo, title, status chip, the agent's pick, budget and priority. */
function SheetHeader(props: {
  card: PlanCard;
  lead: Lead | null;
  titleId: string;
}) {
  const { card, lead, titleId } = props;
  const { item } = card;
  const chip = statusChip(card);
  const meta = [
    item.budget
      ? t('plans.BUDGET_EACH', { price: priceLabel(item.budget) })
      : null,
    item.priority === 'medium'
      ? null
      : t('plans.PRIORITY_BADGE', { priority: priorityLabel(item.priority) }),
  ].filter((part) => part !== null);
  return (
    <div class="flex gap-3">
      <div class="relative aspect-[4/5] w-28 shrink-0 overflow-hidden rounded-box bg-base-200 flex items-center justify-center">
        {lead ? (
          <button
            type="button"
            class="size-full"
            aria-label={enlargeLabel(lead.name)}
            {...viewerTrigger(viewerSetId(card), lead.photo)}
          >
            <LeadPhoto lead={lead} />
          </button>
        ) : (
          <LeadPhoto lead={lead} />
        )}
      </div>
      <div class="flex min-w-0 flex-col items-start gap-1">
        <h2 id={titleId} class="font-semibold text-lg break-words">
          {itemTitle(item)}
        </h2>
        <span class={`badge badge-sm ${chip.class}`} data-status-chip="">
          {chip.text}
        </span>
        {card.status !== 'owned' && card.candidates.some(isAgentsPick) && (
          <span class="badge badge-xs badge-primary" data-agents-pick="">
            {t('plans.AGENTS_PICK')}
          </span>
        )}
        {meta.length > 0 && (
          <p class="text-sm text-muted">{meta.join(' · ')}</p>
        )}
      </div>
    </div>
  );
}

/** The sheet's middle: options, what fulfils the item, why, the owner's note, the review moves. */
function SheetBody(props: {
  card: PlanCard;
  gaps: PlanGaps;
  lead: Lead | null;
}) {
  const { card, gaps, lead } = props;
  const { item, match } = card;
  return (
    <>
      {card.status !== 'owned' && (
        <Options card={card} onPhoto={lead?.candidateId} />
      )}
      {match && match.fulfilledBy.length > 0 && (
        <FulfilledBy match={match} closet={gaps.closet} />
      )}
      {match?.reason && match.reason !== 'nothing-matches' && (
        <p class="text-sm text-muted" data-reason={match.reason}>
          {reasonText(match, gaps)}
        </p>
      )}
      {item.ownerNote && (
        <p class="text-sm" data-owner-note>
          {t('plans.YOUR_NOTE', { note: item.ownerNote })}
        </p>
      )}
      <ReviewMoves item={item} status={card.status} />
    </>
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
      <a href={href} class="link link-primary whitespace-nowrap">
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
    <a href={action('/change')} class="link link-primary text-xs self-start">
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
