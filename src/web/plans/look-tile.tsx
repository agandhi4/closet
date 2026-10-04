import type { Child } from 'hono/jsx';
import type { LookReaction } from '../../wardrobe/look-reaction';
import { PostForm } from '../auth/form';
import { occasionLabel } from '../calendar/labels';
import { t } from '../i18n';
import { type CollagePieceView, OutfitCollage } from '../outfits/collage';
import { outfitUrl } from '../outfits/urls';
import { SnapStrip, snapItem } from '../strip/snap-strip';
import { TILE } from './candidate-tile';
import { type BoughtLook, lookSaveState, type PlanLookView } from './looks';
import { lookUrl } from './urls';

/**
 * What the review page and the plan page share when they draw a plan's
 * looks (#291, epic #289): the strip, each look's face (its collage with
 * the pieces to buy and the missing ones marked, its name, occasion and
 * the agent's note) and the list of looks waiting apart. Each page adds
 * its own reactions under the face: the review's ride in its one post, the
 * plan page's are small native posts.
 */

/** A look's slots as collage pieces, each marked by its derived state. */
export function lookGarments(
  look: Pick<PlanLookView, 'slots'>,
): CollagePieceView[] {
  return look.slots.map((slot) => ({
    name: slot.name,
    category: slot.category,
    photo: slot.state === 'missing' ? null : slot.photo,
    mark:
      slot.state === 'to-buy'
        ? 'to-buy'
        : slot.state === 'missing'
          ? 'missing'
          : undefined,
  }));
}

const CHIPS: Record<LookReaction, string> = {
  proposed: 'badge-primary',
  loved: 'badge-success',
  revise: 'badge-info',
  declined: 'badge-ghost',
};

/** "Work · 2 to buy · 1 piece missing". */
function lookMeta(look: PlanLookView): string {
  const toBuy = look.slots.filter((slot) => slot.state === 'to-buy').length;
  const missing = look.missingPieces.length;
  return [
    look.occasion
      ? occasionLabel(look.occasion)
      : t('plans.looks.ANY_OCCASION'),
    toBuy > 0 ? t('plans.looks.TO_BUY_COUNT', { count: toBuy }) : null,
    missing === 1
      ? t('plans.looks.MISSING_ONE')
      : missing > 1
        ? t('plans.looks.MISSING_MANY', { count: missing })
        : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/**
 * A heading, a hint and the strip of looks, one `card` tile each (the
 * page draws the tiles). Not a listbox: the tiles hold controls, which an
 * `option` would hide from screen readers (the shopping list's rule).
 */
export function LooksStrip(props: {
  id: string;
  count: number;
  hint: Child;
  /** Defaults to "Looks"; the Outfits tab's row is "From your plan". */
  title?: string;
  children: Child;
  /** Each tile's strip-wide hooks (`group/<name>`), the review's. */
  class?: string;
}) {
  return (
    <section
      class="flex flex-col gap-2"
      id={props.id}
      aria-labelledby={`${props.id}-title`}
    >
      <div class="px-4 flex flex-col gap-0.5">
        <h2 id={`${props.id}-title`} class="font-semibold">
          {props.title ?? t('plans.looks.TITLE')}{' '}
          <span class="font-normal text-muted">· {props.count}</span>
        </h2>
        <p class="text-xs text-muted">{props.hint}</p>
      </div>
      <SnapStrip
        size="card"
        label={t('plans.looks.STRIP_LABEL')}
        listbox={false}
        focusable
        class={props.class}
      >
        {props.children}
      </SnapStrip>
    </section>
  );
}

// The shared strip's observer (public/js/snap-strip.js, through the
// importmap): an inline module, so it runs again after a boosted navigation
// brings the page and on a fresh load, where nothing else has loaded it. A
// fixed string with nothing interpolated. Used by the plan page and the
// Outfits tab, both of which render the strip as `#plan-looks`.
export const LOOKS_INIT = `import { initSnapStrips } from 'snap-strip';
initSnapStrips(document.getElementById('plan-looks'));`;

/**
 * A look's tile in a `#plan-looks` strip: its face and, under it, what the
 * page offers (`children`: the plan page's moves, the Outfits tab's save).
 */
export function LookStripTile(props: {
  look: PlanLookView;
  selected: boolean;
  eager: boolean;
  children: Child;
}) {
  const { look } = props;
  return (
    <div
      {...snapItem({
        value: String(look.id),
        selected: props.selected,
        size: 'card',
        listbox: false,
        class: TILE,
      })}
      id={`look-${look.id}`}
      data-look={String(look.id)}
      data-reaction={look.reaction}
    >
      <LookFace look={look} eager={props.eager} />
      {props.children}
    </div>
  );
}

/**
 * A look's face: the collage (4:5, so every tile of a strip is the same
 * height) with its reaction as a chip over the corner, then its name, what
 * it is for with how many pieces are to buy or missing, and the agent's
 * note. The owner's own note shows where they left one.
 */
export function LookFace(props: { look: PlanLookView; eager: boolean }) {
  const { look } = props;
  return (
    <>
      <figure class="relative">
        <OutfitCollage
          garments={lookGarments(look)}
          size="look"
          eager={props.eager}
        />
        <span
          class={`badge badge-sm absolute top-1.5 left-1.5 ${CHIPS[look.reaction]}`}
          data-reaction-chip=""
        >
          {t(`plans.looks.status.${look.reaction}`)}
        </span>
      </figure>
      <h3 class="text-sm font-medium leading-snug line-clamp-2 break-words">
        {look.name}
      </h3>
      <p class="text-xs text-muted">{lookMeta(look)}</p>
      {look.note && (
        <p class="text-xs italic line-clamp-3" data-look-note="">
          {look.note}
        </p>
      )}
      {look.ownerNote && (
        <p class="text-xs line-clamp-3" data-owner-note="">
          {t('plans.YOUR_NOTE', { note: look.ownerNote })}
        </p>
      )}
    </>
  );
}

/**
 * Looks outside the strip, by reaction (revise, declined), as the items
 * waiting apart are listed: each a small collage, its name and the owner's
 * note, and under them whatever moves the page offers (`moves`). Nothing
 * when there are none.
 */
export function LooksApart(props: {
  id: string;
  title: string;
  hint: string;
  looks: PlanLookView[];
  moves?: (look: PlanLookView) => Child;
}) {
  if (props.looks.length === 0) return null;
  return (
    <section
      class="flex flex-col gap-2"
      id={props.id}
      aria-labelledby={`${props.id}-title`}
    >
      <h2 id={`${props.id}-title`} class="font-semibold">
        {props.title}{' '}
        <span class="font-normal text-muted">· {props.looks.length}</span>
      </h2>
      <p class="text-xs text-muted">{props.hint}</p>
      <ul class="flex flex-col divide-y divide-base-300">
        {props.looks.map((look) => (
          <li
            id={`look-${look.id}`}
            data-reaction={look.reaction}
            class="flex items-start gap-3 py-2"
          >
            <div class="w-16 shrink-0">
              <OutfitCollage garments={lookGarments(look)} size="thumb" />
            </div>
            <div class="min-w-0 flex-1 flex flex-col gap-0.5">
              <p class="text-sm font-medium break-words">{look.name}</p>
              <p class="text-xs text-muted">{lookMeta(look)}</p>
              {look.ownerNote && (
                <p class="text-xs" data-owner-note="">
                  {t('plans.YOUR_NOTE', { note: look.ownerNote })}
                </p>
              )}
              {props.moves && <div class="mt-1">{props.moves(look)}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Save as outfit (#292) where the page can post on its own (the plan page,
 * the Bought it result): the button while every piece is owned and the
 * look is not declined (lookSaveState), "Saved as outfit" linking the
 * outfit once it is one, nothing otherwise. A native post, disabled
 * offline, landing on the outfit's page.
 */
export function LookSaveAction({
  look,
}: {
  look: Pick<
    PlanLookView,
    'id' | 'planId' | 'outfitId' | 'complete' | 'reaction'
  >;
}) {
  switch (lookSaveState(look)) {
    case 'saved':
      return (
        <a
          href={outfitUrl(look.outfitId!)}
          class="link link-hover text-xs font-medium"
          data-look-saved=""
          data-strip-action="saved"
        >
          {t('plans.looks.SAVED_AS_OUTFIT')}
        </a>
      );
    case 'saveable':
      return (
        <PostForm action={lookUrl(look.planId, look.id, '/save')} needsNetwork>
          <button
            type="submit"
            class="btn btn-xs btn-primary"
            data-save-look={String(look.id)}
            data-strip-action="save"
          >
            {t('plans.looks.SAVE_AS_OUTFIT')}
          </button>
        </PostForm>
      );
    case 'not-yet':
      return null;
  }
}

/**
 * The review page's word on the same (#292), read-only: a post or a link
 * of its own there would lose the swipes made so far (why Reconsider lives
 * on the plan page only). Save as outfit is the plan page's.
 */
export function LookSaveChip({ look }: { look: PlanLookView }) {
  const state = lookSaveState(look);
  if (state === 'not-yet') return null;
  return (
    <span class="badge badge-sm badge-outline" data-look-save-state={state}>
      {t(
        state === 'saved'
          ? 'plans.looks.SAVED_AS_OUTFIT'
          : 'plans.looks.READY_TO_SAVE',
      )}
    </span>
  );
}

/**
 * The Bought it result (#292, GET /wardrobe/:id?bought=1, the owner's):
 * the looks the purchase completed, each a small collage, its name and
 * plan, and Save as outfit (or the outfit it already is). Nothing when it
 * completed none.
 */
export function CompletedLooks({ looks }: { looks: readonly BoughtLook[] }) {
  if (looks.length === 0) return null;
  return (
    <section
      class="flex flex-col gap-2"
      id="completed-looks"
      aria-labelledby="completed-looks-title"
    >
      <h2 id="completed-looks-title" class="font-semibold">
        {looks.length === 1
          ? t('plans.looks.COMPLETED_ONE')
          : t('plans.looks.COMPLETED_MANY', { count: looks.length })}
      </h2>
      <p class="text-xs text-muted">{t('plans.looks.COMPLETED_HINT')}</p>
      <ul class="flex flex-col divide-y divide-base-300">
        {looks.map((look) => (
          <li
            id={`completed-look-${look.id}`}
            class="flex items-start gap-3 py-2"
          >
            <div class="w-16 shrink-0">
              <OutfitCollage garments={lookGarments(look)} size="thumb" />
            </div>
            <div class="min-w-0 flex-1 flex flex-col gap-0.5">
              <p class="text-sm font-medium break-words">{look.name}</p>
              <p class="text-xs text-muted break-words">
                {t('plans.looks.FROM_PLAN', { plan: look.planName })}
              </p>
              <div class="mt-1">
                <LookSaveAction look={look} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
