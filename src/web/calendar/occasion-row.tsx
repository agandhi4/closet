import { stylingUrl } from '../styling/urls';
import { t } from '../i18n';
import { destinationQuery } from '../outfits/destination';
import { EntrySelfie } from '../selfies/views';
import type { CalendarEntry } from './calendar-view';
import { occasionLabel } from './labels';
import { WornButton } from './worn-button';

/**
 * One calendar entry as a row of its day: the occasion's label, Change
 * (another outfit in its place, #69; not once worn), the outfit (tap to
 * edit it, × to unschedule), the worn pill and its selfie (or the
 * buttons that take one, #19). The one way a day's
 * entries are drawn: the week page stacks them in occasion order, and the
 * redesign's week agenda (R6) and Today (#15) reuse it
 * (docs/plans/2026-09-26-redesign.md, section 5). `data-occasion` is what
 * the specs read the order from. An entry "Plan my week" chose and the
 * person has not touched is marked Auto (#16): its re-plan may swap it.
 */
export function OccasionRow(props: {
  entry: CalendarEntry;
  /** The day is after today: no worn pill (setEntryWorn refuses it). */
  future: boolean;
}) {
  const { entry, future } = props;
  return (
    <div class="flex flex-col gap-0.5 mb-1" data-occasion={entry.occasion}>
      <div class="flex items-center gap-1">
        <span class="text-[10px] font-semibold uppercase tracking-wide text-muted">
          {occasionLabel(entry.occasion)}
          {entry.plannedBy === 'auto' && (
            <span
              class="badge badge-ghost badge-xs ms-1 normal-case tracking-normal"
              title={t('weekPlan.AUTO_TITLE')}
              data-auto
            >
              {t('weekPlan.AUTO')}
            </span>
          )}
        </span>
        {/* Another outfit in this entry's place (#69); a worn entry is the
            record of that day and keeps its outfit. */}
        {!entry.worn && (
          <a
            href={changeEntryUrl(entry)}
            class="btn btn-ghost btn-xs ms-auto h-6 min-h-6 px-2 font-normal text-muted"
            aria-label={t('changeEntry.ACTION_LABEL', {
              name: entry.outfit.name || t('UNTITLED_OUTFIT'),
            })}
            data-change-entry={entry.id}
          >
            {t('changeEntry.ACTION')}
          </a>
        )}
      </div>
      <div class="flex items-center gap-2">
        <EntryChip entry={entry} />
        {/* A planned day has no pill (it cannot be worn yet), unless an
            entry there was marked before that rule, which can still be
            unmarked. */}
        {(!future || entry.worn) && (
          <WornButton entryId={entry.id} worn={entry.worn} week={entry.day} />
        )}
      </div>
      <EntrySelfie
        entryId={entry.id}
        day={entry.day}
        selfie={entry.selfie}
        canTake={!future}
        returnTo={`/calendar?week=${entry.day}`}
        size="row"
      />
    </div>
  );
}

/** The plan page opened to change this entry's outfit (#69). */
function changeEntryUrl(entry: CalendarEntry): string {
  return `/calendar/plan?${destinationQuery({
    kind: 'day',
    day: entry.day,
    occasion: entry.occasion,
    replace: entry.id,
  })}`;
}

/**
 * The outfit bar. It is the edit link's (boosted), stretched over it by its
 * ::after; it holds the delete form, which an <a> cannot, so the form sits
 * above it. The garments are its colour: the bar is the plinth, and only a
 * worn entry takes the accent (#81; a hue per entry told apart what the
 * occasion label above it already names).
 */
function EntryChip({ entry }: { entry: CalendarEntry }) {
  // Editing the outfit is Styling with it open (#42), back to this week.
  const editUrl = stylingUrl({
    outfitId: entry.outfit.id,
    returnTo: `/calendar?week=${entry.day}`,
  });
  const deleteUrl = `/calendar/${entry.id}/delete`;
  const name = entry.outfit.name || t('UNTITLED_OUTFIT');
  return (
    <div
      class={`relative min-w-0 flex-1 text-left px-2.5 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1 leading-tight ${entry.worn ? 'bg-accent/10 border-accent' : 'bg-base-200 border-base-300'}`}
    >
      <a
        href={editUrl}
        class="flex items-center min-w-0 flex-1 after:absolute after:inset-0"
        aria-label={name}
      >
        {entry.outfit.photoUrls.length > 0 ? (
          <span class="flex items-center gap-0.5 min-w-0 overflow-hidden flex-1">
            {entry.outfit.photoUrls.map((src) => (
              <img
                src={src}
                alt=""
                class="size-6 rounded object-cover shrink-0"
                width="24"
                height="24"
                loading="lazy"
                decoding="async"
              />
            ))}
          </span>
        ) : (
          <span class="truncate flex-1">{name}</span>
        )}
      </a>
      <form
        method="post"
        action={deleteUrl}
        hx-post={deleteUrl}
        hx-confirm={t('CALENDAR_DELETE_CONFIRM')}
        hx-vals={JSON.stringify({ week: entry.day })}
        class="relative z-10"
      >
        <input type="hidden" name="week" value={entry.day} />
        <button
          type="submit"
          class="text-muted hover:text-error w-5 h-5 flex items-center justify-center rounded hover:bg-error/10 shrink-0 transition-colors"
          aria-label={t('DELETE')}
        >
          ×
        </button>
      </form>
    </div>
  );
}
