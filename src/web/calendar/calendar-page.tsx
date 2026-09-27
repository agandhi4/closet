import { AlreadySavedToast } from '../gallery/already-saved';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { destinationQuery } from '../outfits/destination';
import { SelfieView } from '../selfies/views';
import type { ViewContext } from '../view-context';
import { WeatherDaySlot, WeatherSlot } from '../weather/views';
import type { CalendarDayView, CalendarView, MonthLink } from './calendar-view';
import { CalendarTabs } from './calendar-tabs';
import { DAY_LETTERS, DAY_NAMES, MONTH_NAMES } from './labels';
import { OccasionRow } from './occasion-row';
import type { PlannedBanner } from '../week-plan/plan';
import {
  PlannedWeekBanner,
  PlanWeekForm,
  UndoneToast,
} from '../week-plan/views';

/**
 * GET /calendar: the Week and Trips tabs (#10), the mini month, then one
 * column per day of the week (Sunday
 * to Saturday) with its entries stacked in occasion order (OccasionRow), the
 * selfies kept after their outfit was deleted (DayLooks, #19), and a link
 * to plan one more (the plan page, GET /calendar/plan). Today's
 * weather heads the page and each day within the forecast gets its chip
 * (#14; both loaded after the page, src/web/weather/views.tsx). "Plan my
 * week" (#16) sits above the week; after it, the banner says what it
 * planned, with Undo.
 * Responsive grid: 1 col, 2 cols from 400px, 4 at lg, all 8 in a row at 2xl.
 */
export function CalendarPage(props: {
  ctx: ViewContext;
  view: CalendarView;
  /** The gallery's pick found its outfit already saved (?alreadySaved=1). */
  alreadySaved?: boolean;
  /** After "Plan my week" (#16, ?planned=). */
  banner?: PlannedBanner;
  /** After its Undo (?undone=N): the entries removed. */
  undone?: number;
}) {
  const { ctx, view } = props;
  return (
    <Layout ctx={ctx} title={t('CALENDAR_PAGE_TITLE')}>
      <AppBar ctx={ctx} title={t('CALENDAR')} />
      <main class="p-4 pt-20 pb-24">
        <CalendarTabs active="week" />
        <WeatherSlot
          ctx={ctx}
          days={{
            from: view.days[0].date,
            to: view.days[view.days.length - 1].date,
          }}
        />
        {props.banner && <PlannedWeekBanner banner={props.banner} />}
        <PlanWeekForm class="mb-3" small />
        <div
          id="week-grid"
          class="grid grid-cols-1 min-[400px]:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8 gap-3"
        >
          <MiniMonth view={view} />
          {view.days.map((day) => (
            <DayColumn ctx={ctx} day={day} />
          ))}
        </div>
      </main>
      <AlreadySavedToast shown={props.alreadySaved === true} />
      <UndoneToast removed={props.undone} />
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

/**
 * The day's selfies no entry holds any more, their outfit deleted (#19) or
 * the entry changed to another (#69): kept as the record of
 * what was worn, like the day's wears, with nothing left to edit but the
 * photo itself.
 */
function DayLooks({ day }: { day: CalendarDayView }) {
  return (
    <div class="flex flex-col gap-0.5 mb-1" data-looks={day.date}>
      <span class="text-[10px] font-semibold uppercase tracking-wide text-base-content/50">
        {t('selfie.DETACHED')}
      </span>
      <div class="flex flex-wrap gap-1">
        {day.looks.map((look) => (
          <SelfieView
            selfie={look}
            day={look.day}
            entryId={null}
            returnTo={`/calendar?week=${day.date}`}
            size="row"
          />
        ))}
      </div>
    </div>
  );
}

function DayColumn({ ctx, day }: { ctx: ViewContext; day: CalendarDayView }) {
  const plan = `/calendar/plan?${destinationQuery({
    kind: 'day',
    day: day.date,
    occasion: 'all-day',
  })}`;
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
        <WeatherDaySlot ctx={ctx} day={day.date} />
      </div>
      <div class="flex flex-col gap-1 p-3 flex-1">
        {day.entries.map((entry) => (
          <OccasionRow entry={entry} future={day.isFuture} />
        ))}
        {day.looks.length > 0 && <DayLooks day={day} />}
        {/* Also the marker the integration specs split day columns on. */}
        <a
          href={plan}
          class="mt-auto pt-2 text-xs text-base-content/40 hover:text-base-content/70 select-none"
        >
          +{' '}
          {day.entries.length > 0
            ? t('CALENDAR_ANOTHER_OUTFIT')
            : t('CALENDAR_PLAN')}
        </a>
      </div>
    </div>
  );
}
