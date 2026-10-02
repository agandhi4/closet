import type { BudgetFit } from '../../wardrobe/shopping';
import { PostForm } from '../auth/form';
import { OutfitCountSlot } from '../gallery/goes-with';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState } from '../layout/parts';
import { SnapStrip, snapItem } from '../strip/snap-strip';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import { priceLabel } from '../wardrobe/garment';
import {
  CandidateFace,
  candidateName,
  DETAILS,
  PLINTH,
  PriceLine,
  TILE,
} from './candidate-tile';
import { differencesText, itemFacts, itemTitle, priorityLabel } from './labels';
import type { PlanDetail, PlanItemRow } from './queries';
import {
  defaultPick,
  offeredValue,
  type PlanReview,
  pickValue,
  type ReviewChoice,
  type ReviewError,
  type ReviewPick,
  type ReviewStrip,
} from './review';
import { ITEM_NOTE_MAX, REJECT_REASON_MAX } from './validation';
import type { ListedCandidate } from './shopping';
import { planUrl, reviewUrl } from './urls';

export interface ReviewPageModel {
  plan: PlanDetail;
  review: PlanReview;
  /** The post named items that changed since its page was drawn (a 400). */
  changed?: boolean;
  /** A refused post's choices, by item (a 400): the strips start where the owner left them. */
  posted?: ReadonlyMap<number, ReviewChoice>;
  /** Why the post was refused, by item. */
  errors?: ReadonlyMap<number, ReviewError>;
}

const ERROR_TEXT = {
  'note-required': 'plans.REVIEW_NOTE_REQUIRED',
} as const;

export const REVIEW_FORM_ID = 'review-form';

// The shared strip's observer (public/js/snap-strip.js, through the
// importmap): an inline module, so it runs again after a boosted navigation
// brings the page (a <script src> module runs once per document). A fixed
// string with nothing interpolated.
const REVIEW_INIT = `import { initSnapStrips } from 'snap-strip';
initSnapStrips(document.getElementById('review-form'));`;

/**
 * GET /wardrobe/plans/:id/review (#271): what the owner's agent proposed,
 * one strip per item (review.ts has the rule and the order), the centred
 * tile its pick, and one native post, "Accept these", deciding them all.
 * Each strip posts its item in `shown` beside its pick, its note for the
 * agent and the candidates it drew in `offered`, each with its "Not this
 * one" box and reason, so only what the page showed is decided or removed.
 * Below, what waits apart (#278): the items sent back to the agent and
 * those declined, with the owner's notes; Reconsider is the plan page's
 * (a post of its own would lose the swipes made here). Private: the
 * signed-in owner's plan only.
 */
export function ReviewPage(props: {
  ctx: ViewContext;
  model: ReviewPageModel;
}) {
  const { ctx, model } = props;
  const { plan } = model;
  const { strips, revise, declined } = model.review;
  const title = t('plans.REVIEW_TITLE', { name: plan.name });
  const anyCandidates = strips.some((strip) => strip.candidates.length > 0);
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={planUrl(plan.id)} formPage />
      <main class="pt-20 pb-24 w-full sm:max-w-lg sm:mx-auto flex flex-col gap-4">
        {model.changed && (
          <div
            role="alert"
            class="alert alert-warning mx-4"
            id="review-changed"
          >
            {t('plans.REVIEW_CHANGED')}
          </div>
        )}
        {model.errors && model.errors.size > 0 && (
          <div role="alert" class="alert alert-error mx-4" id="review-errors">
            {t('plans.REVIEW_FIX_ERRORS')}
          </div>
        )}
        {strips.length === 0 ? (
          <EmptyState message={t('plans.REVIEW_NONE')}>
            <a href={planUrl(plan.id)} class="btn btn-primary btn-sm">
              {plan.name}
            </a>
          </EmptyState>
        ) : (
          <PostForm
            id={REVIEW_FORM_ID}
            action={reviewUrl(plan.id)}
            class="flex flex-col gap-5"
            needsNetwork
          >
            <div class="px-4 flex flex-col gap-1">
              {plan.draftedBy !== null && (
                <p class="text-sm text-muted">
                  {t('plans.DRAFTED_BY', { name: plan.draftedBy })}
                </p>
              )}
              <p class="text-sm text-muted">{t('plans.REVIEW_INTRO')}</p>
              {anyCandidates && (
                <a
                  href={stylingUrl({ planId: plan.id })}
                  class="btn btn-outline btn-sm self-start"
                  data-style-with-closet=""
                >
                  {t('plans.STYLE_WITH_CLOSET')}
                </a>
              )}
            </div>
            {strips.map((strip) => (
              <ItemStrip
                strip={strip}
                posted={model.posted?.get(strip.item.id)}
                error={model.errors?.get(strip.item.id)}
              />
            ))}
            <div class="px-4 flex flex-col gap-3">
              {anyCandidates && (
                <label class="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="removeUnpicked"
                    value="1"
                    class="checkbox checkbox-sm mt-0.5"
                  />
                  <span>
                    {t('plans.REVIEW_REMOVE_UNPICKED')}
                    <span class="block text-xs text-muted">
                      {t('plans.REVIEW_REMOVE_HINT')}
                    </span>
                  </span>
                </label>
              )}
              {!plan.active && (
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="activate"
                    value="1"
                    checked
                    class="checkbox checkbox-sm"
                  />
                  {t('plans.REVIEW_ACTIVATE')}
                </label>
              )}
              <button
                type="submit"
                class="btn btn-primary w-full"
                data-needs-network
              >
                {t('plans.REVIEW_ACCEPT')}
              </button>
            </div>
            <script
              type="module"
              dangerouslySetInnerHTML={{ __html: REVIEW_INIT }}
            />
          </PostForm>
        )}
        <WaitingApart
          id="review-revise"
          title={t('plans.REVISE')}
          hint={t('plans.REVISE_HINT')}
          items={revise}
        />
        <WaitingApart
          id="review-declined"
          title={t('plans.DECLINED')}
          hint={t('plans.DECLINED_HINT')}
          items={declined}
        />
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * Items outside the strips, by review (revise, declined), each with the
 * owner's note: read-only here, decided on the plan page. Nothing when
 * there are none.
 */
function WaitingApart(props: {
  id: string;
  title: string;
  hint: string;
  items: PlanItemRow[];
}) {
  if (props.items.length === 0) return null;
  return (
    <section
      class="px-4 flex flex-col gap-2"
      id={props.id}
      aria-labelledby={`${props.id}-title`}
    >
      <h2
        id={`${props.id}-title`}
        class="text-xs font-semibold uppercase tracking-wide text-muted"
      >
        {props.title} · {props.items.length}
      </h2>
      <p class="text-xs text-muted">{props.hint}</p>
      <ul class="flex flex-col gap-1">
        {props.items.map((item) => (
          <li id={`review-item-${item.id}`} data-review={item.review}>
            <a
              href={planUrl(item.planId)}
              class="link link-hover text-sm font-medium"
            >
              {itemTitle(item)}
            </a>
            {item.ownerNote && (
              <p class="text-xs" data-owner-note>
                {t('plans.YOUR_NOTE', { note: item.ownerNote })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The pick a strip starts on: the posted one when the page is drawn again, else its default. */
function startingPick(
  strip: ReviewStrip,
  posted: ReviewChoice | undefined,
): ReviewPick {
  if (!posted) return defaultPick(strip);
  const { pick } = posted;
  // A posted candidate gone since (bought, unlinked) has no tile to start on.
  return pick.kind !== 'candidate' ||
    strip.candidates.some((c) => c.candidate.garmentId === pick.garmentId)
    ? pick
    : defaultPick(strip);
}

/**
 * An item's strip: what it is (title, quantity, facts, budget, priority,
 * the agent's note), then Don't buy, Change this…, Keep and its
 * candidates, then the note for the agent (required with Change this,
 * optional with Don't buy). The strip's input is the item's `pick`;
 * `shown` says the page showed it, `offered` which candidates it drew.
 * The note follows `shown` in the form's order, as each reason follows its
 * `offered`, so the post pairs them (readReview).
 */
function ItemStrip(props: {
  strip: ReviewStrip;
  posted?: ReviewChoice;
  error?: ReviewError;
}) {
  const { strip, posted, error } = props;
  const { item, candidates } = strip;
  const chosen = pickValue(item.id, startingPick(strip, posted));
  const noteId = `review-note-${item.id}`;
  const tile = (pick: ReviewPick) => {
    const value = pickValue(item.id, pick);
    return { value, selected: value === chosen, size: 'regular' as const };
  };
  const title = itemTitle(item);
  const facts = [
    ...itemFacts(item),
    item.budget
      ? t('shopping.UP_TO', { price: priceLabel(item.budget) })
      : null,
  ].filter(Boolean);
  return (
    <section
      class="flex flex-col gap-2"
      id={`review-item-${item.id}`}
      aria-labelledby={`review-item-${item.id}-title`}
    >
      <div class="px-4 flex flex-col gap-0.5">
        <div class="flex items-start justify-between gap-2">
          <h2
            id={`review-item-${item.id}-title`}
            class="font-medium break-words"
          >
            {title}
            {item.quantity > 1 && (
              <span class="text-muted"> ×{item.quantity}</span>
            )}
          </h2>
          {item.priority !== 'medium' && (
            <span
              class={`badge badge-sm shrink-0 ${item.priority === 'high' ? 'badge-warning' : 'badge-ghost'}`}
            >
              {priorityLabel(item.priority)}
            </span>
          )}
        </div>
        {facts.length > 0 && (
          <p class="text-xs text-muted">{facts.join(' · ')}</p>
        )}
        {item.note && <p class="text-xs italic">{item.note}</p>}
      </div>
      <input type="hidden" name="shown" value={String(item.id)} />
      {candidates.map(({ candidate }) => (
        <input
          type="hidden"
          name="offered"
          value={offeredValue(item.id, candidate.garmentId)}
        />
      ))}
      <SnapStrip
        name="pick"
        value={chosen}
        size="regular"
        label={t('plans.REVIEW_STRIP_LABEL', { item: title })}
      >
        <button
          type="button"
          {...snapItem({ ...tile({ kind: 'decline' }), class: TILE })}
        >
          <span
            class={`${PLINTH} border border-dashed border-base-300 text-2xl text-muted`}
          >
            ✕
          </span>
          <span class="text-xs font-medium">{t('plans.DONT_BUY')}</span>
          <span class={DETAILS}>{t('plans.REVIEW_DECLINE_HINT')}</span>
        </button>
        <button
          type="button"
          {...snapItem({ ...tile({ kind: 'change' }), class: TILE })}
        >
          <span
            class={`${PLINTH} border border-dashed border-base-300 text-2xl text-muted`}
          >
            ✎
          </span>
          <span class="text-xs font-medium">{t('plans.CHANGE_THIS')}</span>
          <span class={DETAILS}>{t('plans.REVIEW_CHANGE_HINT')}</span>
        </button>
        <button
          type="button"
          {...snapItem({ ...tile({ kind: 'keep' }), class: TILE })}
        >
          <span
            class={`${PLINTH} border border-dashed border-base-300 text-2xl text-primary`}
          >
            ✓
          </span>
          <span class="text-xs font-medium">{t('plans.REVIEW_KEEP')}</span>
          <span class={DETAILS}>{t('plans.REVIEW_KEEP_HINT')}</span>
        </button>
        {candidates.map(({ candidate, budget }) => (
          <CandidateTile
            itemId={item.id}
            candidate={candidate}
            budget={budget}
            tile={tile({ kind: 'candidate', garmentId: candidate.garmentId })}
            rejected={posted?.rejected.has(candidate.garmentId) ?? false}
            reason={posted?.rejected.get(candidate.garmentId) ?? ''}
          />
        ))}
      </SnapStrip>
      <div class="px-4 flex flex-col gap-1">
        <label for={noteId} class="text-xs text-muted">
          {t('plans.REVIEW_NOTE_LABEL')}
        </label>
        <textarea
          id={noteId}
          name="note"
          rows={2}
          maxlength={ITEM_NOTE_MAX}
          class={`textarea textarea-sm w-full ${error === 'note-required' ? 'textarea-error' : ''}`}
          placeholder={t('plans.REVIEW_NOTE_PLACEHOLDER')}
          aria-describedby={error ? `${noteId}-error` : undefined}
        >
          {posted?.note ?? ''}
        </textarea>
        {error && (
          <p id={`${noteId}-error`} class="text-xs text-error" data-error>
            {t(ERROR_TEXT[error])}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A candidate: its photo and name (a link to its wishlist page, which a
 * tap on the centred tile opens) and, under it while centred, its price
 * against the budget, whether it is the kind the item asks for and how
 * many outfits it makes with the closet (loaded once seen), and "Not this
 * one" with an optional reason (#278). A `div`, not a link, so the count's
 * own link is not nested in one. The reason input is drawn on every tile,
 * centred or not, so each `offered` has its `rejectReason` to pair with.
 */
function CandidateTile(props: {
  itemId: number;
  candidate: ListedCandidate;
  budget: BudgetFit;
  tile: { value: string; selected: boolean; size: 'regular' };
  rejected: boolean;
  reason: string;
}) {
  const { candidate, budget } = props;
  const name = candidateName(candidate);
  return (
    <div
      {...snapItem({ ...props.tile, class: TILE })}
      data-candidate={String(candidate.garmentId)}
      data-matches={String(candidate.matches)}
    >
      <CandidateFace candidate={candidate} selected={props.tile.selected} />
      <span class={DETAILS}>
        <PriceLine candidate={candidate} budget={budget} />
        {candidate.matches ? (
          <span>{t('plans.REVIEW_MATCHES')}</span>
        ) : (
          <span class="text-warning" data-mismatch>
            {t('shopping.DOESNT_MATCH', {
              differences: differencesText(candidate.differences),
            })}
          </span>
        )}
        <OutfitCountSlot garmentId={candidate.garmentId} inStrip />
        <label class="flex items-center gap-1 text-base-content">
          <input
            type="checkbox"
            name="reject"
            value={offeredValue(props.itemId, candidate.garmentId)}
            checked={props.rejected}
            class="checkbox checkbox-xs"
          />
          {t('plans.NOT_THIS_ONE')}
        </label>
        <input
          type="text"
          name="rejectReason"
          value={props.reason}
          maxlength={REJECT_REASON_MAX}
          class="input input-xs w-full"
          placeholder={t('plans.REJECT_REASON_PLACEHOLDER')}
          aria-label={t('plans.REJECT_REASON_LABEL', { name })}
        />
      </span>
    </div>
  );
}
