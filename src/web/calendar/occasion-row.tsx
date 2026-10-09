import type { Occasion } from '../../wardrobe/occasions';
import { t } from '../i18n';
import { OutfitCollage } from '../outfits/collage';
import { EntrySelfie } from '../selfies/views';
import { stylingUrl } from '../styling/urls';
import type { IsoDate } from '../../calendar-date';
import type { CalendarEntry } from './calendar-view';
import { occasionLabel } from './labels';
import { OPEN_PLAN_SHEET, planSheetChoice } from './plan-sheet';
import { dayUrl, planPageUrl } from './urls';
import { WornButton } from './worn-button';

/**
 * One calendar entry as a row of its day's agenda: the occasion's label
 * (Auto while "Plan my week"'s pick stands untouched, #16), Change (another
 * outfit in its place, #69; not once worn) and × (unschedule); then the
 * outfit as a small OutfitCollage with its name (tap to edit it in
 * Styling), its selfie (or the buttons that take one, #19) and the worn
 * pill. The one way a day's entries are drawn: the week agenda stacks them
 * in occasion order, and Today (#15) draws the same entries larger through
 * the same worn route (docs/plans/2026-09-26-redesign.md, section 5).
 * `data-occasion` is what the specs read the order from.
 */
export function OccasionRow(props: {
  entry: CalendarEntry;
  /** The day is after today: no worn pill (setEntryWorn refuses it). */
  future: boolean;
}) {
  const { entry, future } = props;
  const name = entry.outfit.name || t('UNTITLED_OUTFIT');
  // Back from Styling (#42) and from a selfie lands on this entry's day
  // (`#day-D`), not the top of its week: a later day is a long scroll down.
  const back = dayUrl(entry.day);
  const editUrl = stylingUrl({ outfitId: entry.outfit.id, returnTo: back });
  return (
    <div class="flex flex-col gap-1 py-2" data-occasion={entry.occasion}>
      <div class="flex items-center gap-1 min-h-6">
        <OccasionLabel occasion={entry.occasion} />
        {entry.plannedBy === 'auto' && (
          <span
            class="badge badge-ghost badge-xs"
            title={t('weekPlan.AUTO_TITLE')}
            data-auto
          >
            {t('weekPlan.AUTO')}
          </span>
        )}
        {/* A worn entry is the record of that day and keeps its outfit. */}
        {!entry.worn && (
          <a
            href={planPageUrl({
              kind: 'day',
              day: entry.day,
              occasion: entry.occasion,
              replace: entry.id,
            })}
            class="btn btn-ghost btn-xs ms-auto font-normal text-muted"
            aria-label={t('changeEntry.ACTION_LABEL', { name })}
            data-change-entry={entry.id}
          >
            {t('changeEntry.ACTION')}
          </a>
        )}
        <DeleteEntry entry={entry} pushRight={entry.worn} />
      </div>
      <div class="flex items-center gap-2">
        <a
          href={editUrl}
          class="flex items-center gap-3 min-w-0 flex-1"
          aria-label={name}
        >
          <span class="w-16 shrink-0">
            <OutfitCollage garments={entry.outfit.garments} size="thumb" />
          </span>
          <span class="text-sm font-medium line-clamp-2">{name}</span>
        </a>
        <EntrySelfie
          entryId={entry.id}
          day={entry.day}
          selfie={entry.selfie}
          canTake={!future}
          returnTo={back}
          size="row"
        />
        {/* A planned day has no pill (it cannot be worn yet), unless an
            entry there was marked before that rule, which can still be
            unmarked. */}
        {(!future || entry.worn) && (
          <WornButton entryId={entry.id} worn={entry.worn} week={entry.day} />
        )}
      </div>
    </div>
  );
}

/**
 * A template occasion the day has no outfit for yet (#16), as a row that
 * opens the day's "+ Plan" sheet with the occasion chosen.
 */
export function OpenSlotRow(props: { day: IsoDate; occasion: Occasion }) {
  const { day, occasion } = props;
  return (
    <button
      type="button"
      class="flex items-center gap-3 w-full py-2 text-start"
      data-plan={planSheetChoice(day, occasion)}
      data-open-slot={occasion}
      onclick={OPEN_PLAN_SHEET}
    >
      <span class="w-16 h-12 shrink-0 rounded-field border border-dashed border-base-300"></span>
      <OccasionLabel occasion={occasion} />
      <span class="ms-auto text-sm text-muted">+ {t('CALENDAR_PLAN')}</span>
    </button>
  );
}

function OccasionLabel({ occasion }: { occasion: Occasion }) {
  return (
    <span class="text-xs font-semibold uppercase tracking-wide text-muted">
      {occasionLabel(occasion)}
    </span>
  );
}

/**
 * × to unschedule, confirmed first; htmx swaps in the week it was on. At
 * the row's end: after Change, or pushed there itself (`pushRight`) when a
 * worn entry has no Change.
 */
function DeleteEntry(props: { entry: CalendarEntry; pushRight: boolean }) {
  const { entry } = props;
  const action = `/calendar/${entry.id}/delete`;
  return (
    <form
      method="post"
      action={action}
      hx-post={action}
      hx-confirm={t('CALENDAR_DELETE_CONFIRM')}
      hx-vals={JSON.stringify({ week: entry.day })}
      class={props.pushRight ? 'ms-auto' : undefined}
    >
      <input type="hidden" name="week" value={entry.day} />
      <button
        type="submit"
        class="btn btn-ghost btn-xs btn-square text-muted hover:text-error"
        aria-label={t('DELETE')}
      >
        ×
      </button>
    </form>
  );
}
