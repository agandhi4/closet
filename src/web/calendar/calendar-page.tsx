import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { AlreadySavedToast } from '../gallery/already-saved';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { SelfieView } from '../selfies/views';
import type { ViewContext } from '../view-context';
import { WeatherDaySlot, WeatherSlot } from '../weather/views';
import type { PlannedBanner } from '../week-plan/plan';
import {
  PlannedWeekBanner,
  PlanWeekForm,
  UndoneToast,
} from '../week-plan/views';
import { dateParts } from './calendar-date';
import type { CalendarDayView, CalendarView } from './calendar-view';
import { CalendarTabs } from './calendar-tabs';
import {
  DAY_LETTERS,
  DAY_NAMES,
  dayLabel,
  shortDayLabel,
  weekRangeLabel,
} from './labels';
import { OccasionRow, OpenSlotRow } from './occasion-row';
import { OPEN_PLAN_SHEET, PlanSheet, planSheetChoice } from './plan-sheet';
import { dayAnchor, weekUrl } from './urls';

/**
 * GET /calendar: the week as an agenda (R6; docs/plans/2026-09-26-redesign.md,
 * Calendar). The Week, Month and Trips tabs; today's weather (#14, loaded
 * after the page, src/web/weather/views.tsx); "Plan my week" (#16) and,
 * after it, the banner of what it planned with Undo; the week's ‹ › and its
 * strip of days; then a block per day, Sunday to Saturday: its weather chip,
 * its entries in occasion order (OccasionRow), the week template's
 * occasions it has no outfit for yet (OpenSlotRow), the selfies kept after
 * their outfit went (DayLooks, #19) and "+ Plan", which opens the day's
 * sheet (PlanSheet), unless an open slot already does. `data-day` on each block is what the specs split days
 * on (test/integration/calendar-page.ts).
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
  const first = view.days[0].date;
  const last = view.days[view.days.length - 1].date;
  return (
    <Layout ctx={ctx} title={t('CALENDAR_PAGE_TITLE')}>
      <AppBar ctx={ctx} title={t('CALENDAR')} />
      <main class="p-4 pt-20 pb-24 w-full sm:max-w-lg sm:mx-auto">
        <CalendarTabs active="week" />
        <WeatherSlot ctx={ctx} days={{ from: first, to: last }} />
        {props.banner && <PlannedWeekBanner banner={props.banner} />}
        <PlanWeekForm class="mb-3" small />
        <nav
          class="flex items-center justify-between gap-2"
          aria-label={t('calendar.WEEK_NAV')}
        >
          <a
            href={weekUrl(view.prevWeek)}
            class="btn btn-ghost btn-sm btn-square"
            aria-label={t('calendar.PREV_WEEK')}
          >
            ‹
          </a>
          <p class="font-semibold" data-week={first}>
            {weekRangeLabel(first, last)}
          </p>
          <a
            href={weekUrl(view.nextWeek)}
            class="btn btn-ghost btn-sm btn-square"
            aria-label={t('calendar.NEXT_WEEK')}
          >
            ›
          </a>
        </nav>
        <WeekStrip view={view} />
        {view.days.map((day) => (
          <DaySection ctx={ctx} day={day} />
        ))}
        {/* Outside the day blocks: each is a form of its own, and the
            specs read a day's block for its entries alone. */}
        {view.days.map((day) => (
          <PlanSheet day={day.date} />
        ))}
      </main>
      <AlreadySavedToast shown={props.alreadySaved === true} />
      <UndoneToast removed={props.undone} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The week's days at a glance, each a link down to its block: the letter,
 * the date (today filled) and a dot when something is planned.
 */
function WeekStrip({ view }: { view: CalendarView }) {
  return (
    <ol class="grid grid-cols-7 gap-1 my-2 text-center select-none">
      {view.days.map((day) => (
        <li>
          <a
            href={`#${dayAnchor(day.date)}`}
            class="flex flex-col items-center gap-0.5 py-1 rounded-field hover:bg-base-200"
            aria-label={dayLabel(day.date)}
            aria-current={day.isToday ? 'date' : undefined}
          >
            <span class="text-xs text-muted">
              {t(DAY_LETTERS[day.weekday])}
            </span>
            <span
              class={`flex items-center justify-center size-8 rounded-full text-sm font-semibold ${day.isToday ? 'bg-primary text-primary-content' : ''}`}
            >
              {dateParts(day.date).day}
            </span>
            <span
              class={`size-1 rounded-full ${day.entries.length > 0 ? 'bg-accent' : ''}`}
            ></span>
          </a>
        </li>
      ))}
    </ol>
  );
}

function DaySection({ ctx, day }: { ctx: ViewContext; day: CalendarDayView }) {
  return (
    <section
      id={dayAnchor(day.date)}
      class="scroll-mt-20 py-3 border-t border-base-300"
      data-day={day.date}
      aria-labelledby={`${dayAnchor(day.date)}-title`}
    >
      <div class="flex items-baseline gap-2">
        <h2
          id={`${dayAnchor(day.date)}-title`}
          class={`text-sm font-semibold ${day.isToday ? 'text-primary' : ''}`}
        >
          {t(DAY_NAMES[day.weekday])}{' '}
          <span class="ms-1 font-normal text-muted">
            {shortDayLabel(day.date)}
          </span>
        </h2>
        {day.isToday && (
          <span class="badge badge-sm badge-primary">{t('today.TITLE')}</span>
        )}
        <WeatherDaySlot ctx={ctx} day={day.date} />
      </div>
      {day.entries.map((entry) => (
        <OccasionRow entry={entry} future={day.isFuture} />
      ))}
      {day.openSlots.map((occasion) => (
        <OpenSlotRow day={day.date} occasion={occasion} />
      ))}
      {day.looks.length > 0 && <DayLooks day={day} />}
      {/* One way into the sheet per day: an open slot opens the same sheet
          (every occasion on it), so the day's own button would say it
          twice. */}
      {day.openSlots.length === 0 && (
        <button
          type="button"
          class="btn btn-ghost btn-sm mt-1 -ms-3 font-normal text-muted"
          data-plan={planSheetChoice(day.date, DEFAULT_OCCASION)}
          data-day-plan={day.date}
          onclick={OPEN_PLAN_SHEET}
        >
          +{' '}
          {day.entries.length > 0
            ? t('CALENDAR_ANOTHER_OUTFIT')
            : t('CALENDAR_PLAN')}
        </button>
      )}
    </section>
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
    <div class="flex flex-col gap-0.5 py-2" data-looks={day.date}>
      <span class="text-xs font-semibold uppercase tracking-wide text-muted">
        {t('selfie.DETACHED')}
      </span>
      <div class="flex flex-wrap gap-1">
        {day.looks.map((look) => (
          <SelfieView
            selfie={look}
            day={look.day}
            entryId={null}
            returnTo={weekUrl(day.date)}
            size="row"
          />
        ))}
      </div>
    </div>
  );
}
