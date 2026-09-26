import { t } from '../i18n';
import type { IsoDate } from './calendar-date';

/**
 * An entry's "Worn?" / "✓ Worn" pill: part of each chip on the calendar page,
 * and the whole response of POST /calendar/:id/worn to htmx, which swaps it
 * in place of the form that was posted (hx-target="this"). It posts the
 * state it asks for (`worn`), so a double tap or a replayed post marks once
 * (setEntryWorn); pills cached before it did post none and toggle.
 */
export function WornButton(props: {
  entryId: number;
  worn: boolean;
  /**
   * The day the chip is on: a plain (no-htmx) post redirects to its week.
   * Absent after a post that sent none; the redirect is then the current week.
   */
  week?: IsoDate;
}) {
  const action = `/calendar/${props.entryId}/worn`;
  return (
    <form
      method="post"
      action={action}
      class="shrink-0"
      hx-post={action}
      hx-target="this"
      hx-swap="outerHTML"
      data-needs-network=""
    >
      {props.week && <input type="hidden" name="week" value={props.week} />}
      <input type="hidden" name="worn" value={props.worn ? '0' : '1'} />
      <button
        type="submit"
        class={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
          props.worn
            ? 'bg-success text-success-content'
            : 'text-base-content/40 italic font-normal hover:text-base-content/70'
        }`}
      >
        {props.worn
          ? `✓ ${t('CALENDAR_WORN')}`
          : t('CALENDAR_MARK_WORN_PROMPT')}
      </button>
    </form>
  );
}
