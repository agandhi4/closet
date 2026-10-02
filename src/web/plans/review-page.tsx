import type { BudgetFit } from '../../wardrobe/shopping';
import { PostForm } from '../auth/form';
import { imageUrl } from '../files/image-url';
import { OutfitCountSlot } from '../gallery/goes-with';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState, HangerIcon } from '../layout/parts';
import { SnapStrip, snapItem } from '../strip/snap-strip';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import { differencesText, itemFacts, itemTitle, priorityLabel } from './labels';
import type { PlanDetail } from './queries';
import {
  defaultPick,
  offeredValue,
  pickValue,
  type ReviewPick,
  type ReviewStrip,
} from './review';
import type { ListedCandidate } from './shopping';
import { planUrl, reviewUrl } from './urls';

export interface ReviewPageModel {
  plan: PlanDetail;
  strips: ReviewStrip[];
  /** The post named items that changed since its page was drawn (a 400). */
  changed?: boolean;
}

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
 * Each strip posts its item in `shown` beside its pick and the candidates
 * it drew in `offered`, so only what the page showed is decided or removed. Private: the signed-in owner's plan only.
 */
export function ReviewPage(props: {
  ctx: ViewContext;
  model: ReviewPageModel;
}) {
  const { ctx, model } = props;
  const { plan, strips } = model;
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
            </div>
            {strips.map((strip) => (
              <ItemStrip strip={strip} />
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
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * An item's strip: what it is (title, quantity, facts, budget, priority,
 * the agent's note), then Skip, Keep and its candidates. The strip's input
 * is the item's `pick`; `shown` says the page showed it, `offered` which
 * candidates it drew.
 */
function ItemStrip({ strip }: { strip: ReviewStrip }) {
  const { item, candidates } = strip;
  const chosen = pickValue(item.id, defaultPick(strip));
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
          {...snapItem({ ...tile({ kind: 'skip' }), class: TILE })}
        >
          <span
            class={`${PLINTH} border border-dashed border-base-300 text-2xl text-muted`}
          >
            ✕
          </span>
          <span class="text-xs font-medium">{t('plans.REVIEW_SKIP')}</span>
          <span class={DETAILS}>{t('plans.REVIEW_SKIP_HINT')}</span>
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
            candidate={candidate}
            budget={budget}
            tile={tile({ kind: 'candidate', garmentId: candidate.garmentId })}
          />
        ))}
      </SnapStrip>
    </section>
  );
}

const TILE = 'flex flex-col gap-1 text-left';
/** The square every tile draws on; ringed when it is the strip's pick. */
const PLINTH =
  'aspect-square w-full rounded-box flex items-center justify-center ring-inset group-data-selected/item:ring-2 group-data-selected/item:ring-primary';
/**
 * What is said under the centred tile only: the neighbours keep the space
 * (invisible, not hidden), so the strip does not jump as the pick moves.
 */
const DETAILS =
  'text-xs text-muted invisible group-data-selected/item:visible flex flex-col gap-0.5';

const BUDGET_TEXT: Record<
  BudgetFit,
  'shopping.WITHIN_BUDGET' | 'shopping.OVER_BUDGET' | null
> = {
  within: 'shopping.WITHIN_BUDGET',
  over: 'shopping.OVER_BUDGET',
  unknown: null,
};

/**
 * A candidate: its photo and name (a link to its wishlist page, which a
 * tap on the centred tile opens) and, under it while centred, its price
 * against the budget, whether it is the kind the item asks for and how
 * many outfits it makes with the closet (loaded once seen). A `div`, not
 * a link, so the count's own link is not nested in one.
 */
function CandidateTile(props: {
  candidate: ListedCandidate;
  budget: BudgetFit;
  tile: { value: string; selected: boolean; size: 'regular' };
}) {
  const { candidate, budget } = props;
  const name = candidate.name ?? categoryLabel(candidate.category);
  const budgetText = BUDGET_TEXT[budget];
  return (
    <div
      {...snapItem({ ...props.tile, class: TILE })}
      data-candidate={String(candidate.garmentId)}
      data-matches={String(candidate.matches)}
    >
      <a
        href={garmentUrl(candidate.garmentId, undefined)}
        class="flex flex-col gap-1 no-underline"
      >
        <span class={`${PLINTH} bg-base-200 p-2`}>
          {candidate.photo ? (
            <img
              src={imageUrl(candidate.photo, 'thumb')}
              alt=""
              class="max-h-full max-w-full object-contain"
              width="200"
              height="200"
              loading={props.tile.selected ? 'eager' : 'lazy'}
              decoding="async"
            />
          ) : (
            <HangerIcon class="size-10 text-faint" strokeWidth="1" />
          )}
        </span>
        <span class="text-xs font-medium truncate">{name}</span>
      </a>
      <span class={DETAILS}>
        {candidate.price && (
          <span class="text-base-content">
            {priceLabel(candidate.price)}
            {budgetText && (
              <span class={budget === 'over' ? 'text-warning' : 'text-success'}>
                {' · '}
                {t(budgetText)}
              </span>
            )}
          </span>
        )}
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
      </span>
    </div>
  );
}
