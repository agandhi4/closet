import { t } from '../i18n';
import type { IsoDate } from './calendar-date';

/**
 * An entry's "Worn?" / "✓ Worn" pill: part of each chip on the calendar page,
 * and the whole response of POST /calendar/:id/worn to htmx, which swaps it
 * in place of the form that was posted (hx-target="this").
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
    >
      {props.week && <input type="hidden" name="week" value={props.week} />}
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
