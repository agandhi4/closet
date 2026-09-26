import { t, type StringKey } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import type { ViewContext } from '../view-context';
import type { MonthLink } from './calendar-view';
import type {
  CalendarDayView,
  CalendarEntryView,
  CalendarView,
} from './calendar-view';
import { WornButton } from './worn-button';

/** Indexed by weekday, 0 = Sunday. */
const DAY_NAMES: StringKey[] = [
  'CALENDAR_DAY_SUN',
  'CALENDAR_DAY_MON',
  'CALENDAR_DAY_TUE',
  'CALENDAR_DAY_WED',
  'CALENDAR_DAY_THU',
  'CALENDAR_DAY_FRI',
  'CALENDAR_DAY_SAT',
];

const DAY_LETTERS: StringKey[] = [
  'CALENDAR_CAL_SUN_LETTER',
  'CALENDAR_CAL_MON_LETTER',
  'CALENDAR_CAL_TUE_LETTER',
  'CALENDAR_CAL_WED_LETTER',
  'CALENDAR_CAL_THU_LETTER',
  'CALENDAR_CAL_FRI_LETTER',
  'CALENDAR_CAL_SAT_LETTER',
];

/** Indexed by month - 1. */
const MONTH_NAMES: StringKey[] = [
  'MONTH_JAN',
  'MONTH_FEB',
  'MONTH_MAR',
  'MONTH_APR',
  'MONTH_MAY',
  'MONTH_JUN',
  'MONTH_JUL',
  'MONTH_AUG',
  'MONTH_SEP',
  'MONTH_OCT',
  'MONTH_NOV',
  'MONTH_DEC',
];

/**
 * GET /calendar: the mini month, then one column per day of the week (Sunday
 * to Saturday) with its outfit chips and a "+ Build outfit" link.
 * Responsive grid: 1 col, 2 cols from 400px, 4 at lg, all 8 in a row at 2xl.
 */
export function CalendarPage(props: { ctx: ViewContext; view: CalendarView }) {
  const { ctx, view } = props;
  return (
    <Layout ctx={ctx} title={t('CALENDAR_PAGE_TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24">
        <div
          id="week-grid"
          class="grid grid-cols-1 min-[400px]:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8 gap-3"
        >
          <MiniMonth view={view} />
          {view.days.map((day) => (
            <DayColumn day={day} />
          ))}
        </div>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function monthHref(link: MonthLink): string {
  return `/calendar?week=${link.week}&calMonth=${link.calMonth}`;
}

function MiniMonth({ view }: { view: CalendarView }) {
  const { miniMonth } = view;
  return (
    <div class="bg-base-200 rounded-xl overflow-hidden min-h-48 flex flex-col">
      <div class="flex items-center justify-between px-3 py-2 bg-base-300 border-b border-base-300">
        <a
          href={monthHref(miniMonth.prev)}
          class="btn btn-ghost btn-xs btn-square"
          aria-label="Previous month"
        >
          ‹
        </a>
        <p class="text-xs font-semibold uppercase tracking-wide text-base-content/50">
          {t(MONTH_NAMES[miniMonth.month.month - 1])} {miniMonth.month.year}
        </p>
        <a
          href={monthHref(miniMonth.next)}
          class="btn btn-ghost btn-xs btn-square"
          aria-label="Next month"
        >
          ›
        </a>
      </div>
      <div class="p-3 flex-1">
        <table class="w-full table-fixed text-[10px] select-none">
          <thead>
            <tr>
              {DAY_LETTERS.map((key) => (
                <th class="text-center font-medium text-base-content/40 pb-0.5 w-[14.28%]">
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {miniMonth.weeks.map((week) => (
              <tr>
                {week.days.map((day) => (
                  <td class="text-center p-0">
                    <a
                      href={`/calendar?week=${week.start}`}
                      class={`flex items-center justify-center size-5 mx-auto my-0.5 rounded-full text-[10px] ${day.cellClass}`}
                    >
                      {day.dayNum}
                    </a>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DayColumn({ day }: { day: CalendarDayView }) {
  return (
    <div class="bg-base-200 rounded-xl overflow-hidden min-h-48 flex flex-col">
      <div class="flex items-baseline gap-1.5 px-3 py-2 bg-base-300 border-b border-base-300">
        <span
          class={`text-xs font-semibold ${day.isToday ? 'text-primary' : 'text-base-content/50'}`}
        >
          {t(DAY_NAMES[day.weekday])}
        </span>
        <span
          class={`text-base font-bold${day.isToday ? ' text-primary' : ''}`}
        >
          {day.dayNum}
        </span>
      </div>
      <div class="flex flex-col gap-1 p-3 flex-1">
        {day.entries.map((entry) => (
          <EntryChip entry={entry} />
        ))}
        {/* Also the marker the integration specs split day columns on. */}
        <a
          href={`/outfits/new?scheduleDate=${day.date}&returnTo=/calendar`}
          class="mt-auto pt-2 text-xs text-base-content/30 hover:text-base-content/60 select-none"
        >
          + {t('BUILD_OUTFIT')}
        </a>
      </div>
    </div>
  );
}

// Inline hues per entry so chips on one day differ; a worn chip is stronger.
function chipStyle(hue: number, worn: boolean): string {
  return worn
    ? `background:hsl(${hue} 65% 55% / 0.22);border-color:hsl(${hue} 65% 60% / 0.45);color:hsl(${hue} 80% 75%)`
    : `background:hsl(${hue} 55% 50% / 0.08);border-color:hsl(${hue} 55% 55% / 0.22);color:hsl(${hue} 50% 65%)`;
}

/**
 * The outfit bar (tap to edit the outfit, × to unschedule) and the worn pill.
 * The bar navigates by script because it contains the delete form, which an
 * <a> cannot.
 */
function EntryChip({ entry }: { entry: CalendarEntryView }) {
  const editUrl = `/outfits/${entry.outfit.id}/edit?returnTo=/calendar&returnToWeek=${entry.day}`;
  const deleteUrl = `/calendar/${entry.id}/delete`;
  return (
    <div class="flex items-center gap-2 mb-1">
      <div
        class="min-w-0 flex-1 text-left px-2.5 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1 leading-tight cursor-pointer"
        style={chipStyle(entry.chipHue, entry.worn)}
        onclick={`window.location.href=${JSON.stringify(editUrl)}`}
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
          <span class="truncate flex-1">
            {entry.outfit.name || t('UNTITLED_OUTFIT')}
          </span>
        )}
        <form
          method="post"
          action={deleteUrl}
          hx-post={deleteUrl}
          hx-confirm={t('CALENDAR_DELETE_CONFIRM')}
          hx-vals={JSON.stringify({ week: entry.day })}
        >
          <input type="hidden" name="week" value={entry.day} />
          <button
            type="submit"
            onclick="event.stopPropagation()"
            class="text-base-content/30 hover:text-error w-5 h-5 flex items-center justify-center rounded hover:bg-error/10 shrink-0 transition-colors"
            aria-label={t('DELETE')}
          >
            ×
          </button>
        </form>
      </div>
      <WornButton entryId={entry.id} worn={entry.worn} week={entry.day} />
    </div>
  );
}
