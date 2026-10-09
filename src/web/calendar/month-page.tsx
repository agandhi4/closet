import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { bodyOf, OutfitCollage } from '../outfits/collage';
import type { ViewContext } from '../view-context';
import {
  WeatherCellSlot,
  weatherDayId,
  WeatherMonthLoader,
} from '../weather/views';
import type { MonthDayView, MonthView } from './calendar-view';
import { PageMain } from '../layout/page-main';
import { CalendarTabs } from './calendar-tabs';
import { DAY_LETTERS, dayLabel, monthLabel } from '../date-labels';
import { dayUrl, monthUrl } from './urls';

/**
 * GET /calendar/month[?month=YYYY-MM]: the history view (R6;
 * docs/plans/2026-09-26-redesign.md, Calendar: "what did I wear in
 * August"). A Sunday-to-Saturday grid of the month's days, each with its
 * first entry's collage (occasion order) and how many more; a worn day has
 * the accent's dot. A day links to its week, scrolled to it: the
 * agenda is where an entry is changed. Network first like any page with a
 * query; the Month tab itself carries none and opens this month. The days
 * the forecast reaches keep room for a weather chip under the date, loaded
 * after the page (#201, WeatherMonthLoader), never rendered in it.
 */
export function MonthPage(props: { ctx: ViewContext; view: MonthView }) {
  const { ctx, view } = props;
  const title = monthLabel(view.month);
  return (
    <Layout ctx={ctx} title={t('CALENDAR_PAGE_TITLE')}>
      <AppBar ctx={ctx} title={t('CALENDAR')} />
      <PageMain width="wide" class="p-4 pt-20 pb-24">
        <CalendarTabs active="month" />
        <WeatherMonthLoader ctx={ctx} days={view.forecast} />
        <nav
          class="flex items-center justify-between gap-2 mb-2"
          aria-label={t('calendar.MONTH_NAV')}
        >
          <a
            href={monthUrl(view.prev)}
            class="btn btn-ghost btn-sm btn-square"
            aria-label={t('calendar.PREV_MONTH')}
          >
            ‹
          </a>
          <h2 class="font-semibold">{title}</h2>
          <a
            href={monthUrl(view.next)}
            class="btn btn-ghost btn-sm btn-square"
            aria-label={t('calendar.NEXT_MONTH')}
          >
            ›
          </a>
        </nav>
        <table class="w-full table-fixed border-separate border-spacing-1 -mx-1">
          <caption class="sr-only">{title}</caption>
          <thead>
            <tr>
              {DAY_LETTERS.map((key) => (
                <th scope="col" class="text-xs font-medium text-muted">
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.weeks.map((week) => (
              <tr>
                {week.map((day) => (
                  <td class="p-0 align-top">
                    {day && <MonthDay ctx={ctx} day={day} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function MonthDay({ ctx, day }: { ctx: ViewContext; day: MonthDayView }) {
  const [first] = day.entries;
  // The link's aria-label stands in for its content, so the chip is read as
  // its description instead.
  const weather = ctx.weatherEnabled && day.inForecast;
  const more = day.entries.length - 1;
  const worn = isWorn(day);
  return (
    <a
      href={dayUrl(day.date)}
      class="flex flex-col items-center gap-0.5 min-h-16 p-0.5 lg:min-h-32 lg:p-1 rounded-field overflow-hidden hover:bg-base-200"
      aria-label={cellLabel(day)}
      aria-current={day.isToday ? 'date' : undefined}
      aria-describedby={weather ? weatherDayId(day.date) : undefined}
      data-month-day={day.date}
      data-worn={worn ? '' : undefined}
    >
      <span
        class={`flex items-center justify-center size-6 rounded-full text-xs font-semibold lg:size-8 lg:text-sm ${day.isToday ? 'bg-primary text-primary-content' : ''}`}
      >
        {day.dayNum}
      </span>
      {weather && <WeatherCellSlot ctx={ctx} day={day.date} />}
      {first && (
        <span class="w-full">
          <OutfitCollage garments={bodyOf(first.outfit.garments)} size="cell" />
        </span>
      )}
      {worn && <span class="size-1 rounded-full bg-accent"></span>}
      {more > 0 && (
        <span class="text-xs text-muted">
          {t('calendar.MORE', { count: more })}
        </span>
      )}
    </a>
  );
}

function isWorn(day: MonthDayView): boolean {
  return day.entries.some((entry) => entry.worn);
}

/** "Wednesday, Mar 14, Linen, Worn": the day, its outfits, and whether worn. */
function cellLabel(day: MonthDayView): string {
  return [
    dayLabel(day.date),
    ...day.entries.map((entry) => entry.outfit.name || t('UNTITLED_OUTFIT')),
    ...(isWorn(day) ? [t('CALENDAR_WORN')] : []),
  ].join(', ');
}
