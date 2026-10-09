import { PostForm } from '../auth/form';
import { t } from '../i18n';

/** POST /calendar/:id/worn (calendar routes): the one write behind every control. */
export function entryWornUrl(entryId: number): string {
  return `/calendar/${entryId}/worn`;
}

type WornControlTarget =
  /** An entry on the calendar, worn or not: marked and unmarked in place. */
  | { worn: boolean; entryId: number; createUrl?: undefined }
  /**
   * Not on the calendar yet (a trip's outfit): "Wore it" posts to the
   * caller's create-and-wear route, which plans it today and marks it worn.
   */
  | { worn: false; entryId?: undefined; createUrl: string };

export type WornControlProps = WornControlTarget & {
  /** `pill`: a dense row (the calendar, a trip); `button`: a hero card (Today). */
  size: 'pill' | 'button';
  /**
   * Swapped in place by htmx rather than a native post the page comes back
   * from whole. Only the calendar's pill: POST /calendar/:id/worn answers
   * htmx with exactly that pill, and nothing else on its row reads the
   * state. Today's Change goes once worn and a trip's create-and-wear route
   * answers only a redirect, so those reload.
   */
  inPlace?: boolean;
  /** A day before today: asks ("Worn?") rather than tells ("Wore it"). */
  past?: boolean;
  /** Where a native post comes back to (safeReturnTo, on the worn route). */
  returnTo: string;
};

/**
 * Marking an outfit worn, the same words, look and undo wherever it is
 * tapped (#359): not worn, "Wore it" ("Worn?" on a past day); worn, a
 * success badge "✓ Worn" and a quiet Undo. Every state posts the state it
 * asks for, so a double tap or a replayed post marks once (setEntryWorn).
 * Disabled offline (data-needs-network). Used by the calendar's
 * OccasionRow and its worn route, Today's PlannedCard and a trip's outfit
 * rows; a garment's own "Wore today" (wear-section.tsx) is a different
 * record (one garment, no entry) and stays its own control.
 */
export function WornControl(props: WornControlProps) {
  const pill = props.size === 'pill';
  const onEntry = props.createUrl === undefined;
  const action = onEntry ? entryWornUrl(props.entryId) : props.createUrl;
  const fields = onEntry && (
    <>
      <input type="hidden" name="worn" value={props.worn ? '0' : '1'} />
      <input type="hidden" name="returnTo" value={props.returnTo} />
    </>
  );
  const body = props.worn ? (
    <>
      <span
        class={`badge badge-success gap-1 whitespace-nowrap ${pill ? 'badge-sm' : ''}`}
        data-worn=""
      >
        ✓ {t('wear.WORN')}
      </span>
      <button
        type="submit"
        class="btn btn-ghost btn-xs font-normal text-muted hover:text-base-content"
      >
        {t('wear.UNDO_WORN')}
      </button>
    </>
  ) : (
    <button type="submit" class={wearClass(props.size, props.past === true)}>
      {props.past ? t('wear.WORN_ASK') : t('wear.WORE_IT')}
    </button>
  );
  const layout = props.worn
    ? 'flex items-center gap-1 shrink-0'
    : pill
      ? 'shrink-0'
      : 'flex flex-1';
  if (props.inPlace) {
    return (
      <form
        method="post"
        action={action}
        class={layout}
        hx-post={action}
        hx-target="this"
        hx-swap="outerHTML"
        data-needs-network=""
      >
        {fields}
        {body}
      </form>
    );
  }
  return (
    <PostForm action={action} class={layout} needsNetwork>
      {fields}
      {body}
    </PostForm>
  );
}

function wearClass(size: WornControlProps['size'], past: boolean): string {
  if (size === 'button') {
    return 'btn btn-primary btn-sm flex-1 whitespace-nowrap';
  }
  // The pill: a past day's question stays quiet beside a dense row; today's
  // verb is a call to act.
  return past
    ? 'btn btn-ghost btn-xs rounded-full font-normal italic text-muted hover:text-base-content'
    : 'btn btn-outline btn-xs rounded-full';
}
