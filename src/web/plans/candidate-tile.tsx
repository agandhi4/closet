import type { BudgetFit } from '../../wardrobe/shopping';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { HangerIcon } from '../layout/parts';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import type { ListedCandidate } from './shopping';

/**
 * What the plan review's strips (review-page.tsx) and the shopping list's
 * (shopping-page.tsx) share when they draw a candidate product as a tile of
 * the shared snap strip (src/web/strip/CLAUDE.md).
 */

export const TILE = 'flex flex-col gap-1 text-left';

/** The square every tile draws on; ringed when it is the strip's pick. */
export const PLINTH =
  'aspect-square w-full rounded-box flex items-center justify-center ring-inset group-data-selected/item:ring-2 group-data-selected/item:ring-primary';

/**
 * What is said under the centred tile only: the neighbours keep the space
 * (invisible, not hidden), so the strip does not jump as the pick moves.
 * Invisible also takes a link or field out of reach, so only the centred
 * tile's can be tapped.
 */
export const DETAILS =
  'text-xs text-muted invisible group-data-selected/item:visible flex flex-col gap-0.5';

const BUDGET_TEXT: Record<
  BudgetFit,
  'shopping.WITHIN_BUDGET' | 'shopping.OVER_BUDGET' | null
> = {
  within: 'shopping.WITHIN_BUDGET',
  over: 'shopping.OVER_BUDGET',
  unknown: null,
};

export function candidateName(candidate: ListedCandidate): string {
  return candidate.name ?? categoryLabel(candidate.category);
}

/**
 * A candidate's photo and name, a link to its wishlist page (which a tap on
 * the centred tile opens). The photo of the centred tile loads eagerly.
 */
export function CandidateFace(props: {
  candidate: ListedCandidate;
  selected: boolean;
}) {
  const { candidate } = props;
  return (
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
            loading={props.selected ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : (
          <HangerIcon class="size-10 text-faint" strokeWidth="1" />
        )}
      </span>
      <span class="text-xs font-medium truncate">
        {candidateName(candidate)}
      </span>
      {isAgentsPick(candidate) && <AgentsPick />}
    </a>
  );
}

/** Rank 1: the option the agent recommends (#293). */
export function isAgentsPick(candidate: { rank: number | null }): boolean {
  return candidate.rank === 1;
}

/** The "Agent's pick" mark, drawn under the name of the pick on every tile that shows it. */
export function AgentsPick() {
  return (
    <span class="badge badge-primary badge-xs self-start" data-agents-pick="">
      {t('plans.AGENTS_PICK')}
    </span>
  );
}

/**
 * The agent's note on a candidate (#293), under its price. Wrapped, never
 * cut: a tile is 7 rem wide and the note's cap (CANDIDATE_NOTE_MAX) is
 * what keeps the strip's height in reach.
 */
export function CandidateNote(props: { candidate: { note: string | null } }) {
  const { note } = props.candidate;
  if (!note) return null;
  return (
    <span class="text-base-content break-words" data-candidate-note="">
      {note}
    </span>
  );
}

/** The price, with whether it is within the item's budget; nothing when unpriced. */
export function PriceLine(props: {
  candidate: ListedCandidate;
  budget: BudgetFit;
}) {
  const { candidate, budget } = props;
  const budgetText = BUDGET_TEXT[budget];
  if (!candidate.price) return null;
  return (
    <span class="text-base-content">
      {priceLabel(candidate.price)}
      {budgetText && (
        <span class={budget === 'over' ? 'text-warning' : 'text-success'}>
          {' · '}
          {t(budgetText)}
        </span>
      )}
    </span>
  );
}
