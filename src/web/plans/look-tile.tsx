import type { Child } from 'hono/jsx';
import type { LookReaction } from '../../wardrobe/look-reaction';
import { occasionLabel } from '../calendar/labels';
import { t } from '../i18n';
import { type CollagePieceView, OutfitCollage } from '../outfits/collage';
import { SnapStrip } from '../strip/snap-strip';
import type { PlanLookView } from './looks';

/**
 * What the review page and the plan page share when they draw a plan's
 * looks (#291, epic #289): the strip, each look's face (its collage with
 * the pieces to buy and the missing ones marked, its name, occasion and
 * the agent's note) and the list of looks waiting apart. Each page adds
 * its own reactions under the face: the review's ride in its one post, the
 * plan page's are small native posts.
 */

/** A look's slots as collage pieces, each marked by its derived state. */
function lookGarments(look: PlanLookView): CollagePieceView[] {
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
  hint: string;
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
          {t('plans.looks.TITLE')}{' '}
          <span class="font-normal text-muted">· {props.count}</span>
        </h2>
        <p class="text-xs text-muted">{props.hint}</p>
      </div>
      <SnapStrip
        size="card"
        label={t('plans.looks.STRIP_LABEL')}
        listbox={false}
        class={props.class}
      >
        {props.children}
      </SnapStrip>
    </section>
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
