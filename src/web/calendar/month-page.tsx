import { categoryRole } from '../../wardrobe/properties';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { type CollageGarment, OutfitCollage } from '../outfits/collage';
import type { ViewContext } from '../view-context';
import type { MonthDayView, MonthView } from './calendar-view';
import { CalendarTabs } from './calendar-tabs';
import { DAY_LETTERS, dayLabel, monthLabel } from './labels';
import { dayUrl, monthUrl } from './urls';

/**
 * GET /calendar/month[?month=YYYY-MM]: the history view (R6;
 * docs/plans/2026-09-26-redesign.md, Calendar: "what did I wear in
 * August"). A Sunday-to-Saturday grid of the month's days, each with its
 * first entry's collage (occasion order) and how many more; a worn day has
 * the accent's dot. A day links to its week, scrolled to it: the
 * agenda is where an entry is changed. Network first like any page with a
 * query; the Month tab itself carries none and opens this month.
 */
export function MonthPage(props: { ctx: ViewContext; view: MonthView }) {
  const { ctx, view } = props;
  const title = monthLabel(view.month);
  return (
    <Layout ctx={ctx} title={t('CALENDAR_PAGE_TITLE')}>
      <AppBar ctx={ctx} title={t('CALENDAR')} />
      <main class="p-4 pt-20 pb-24 w-full sm:max-w-lg sm:mx-auto">
        <CalendarTabs active="month" />
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
                  <td class="p-0 align-top">{day && <MonthDay day={day} />}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The outfit's body for a cell about 48 px wide: the thumb collage's side
 * column (accessories, bags) would take half of it and shrink the rest to
 * specks, so it is left out here; the week's rows show the whole outfit.
 */
function bodyOf(garments: readonly CollageGarment[]): CollageGarment[] {
  const side = ['accessory', 'bag', 'none'];
  const body = garments.filter((g) => !side.includes(categoryRole(g.category)));
  return body.length > 0 ? body : [...garments];
}

function MonthDay({ day }: { day: MonthDayView }) {
  const [first] = day.entries;
  const more = day.entries.length - 1;
  const worn = day.entries.some((entry) => entry.worn);
  const outfits = day.entries.map(
    (entry) => entry.outfit.name || t('UNTITLED_OUTFIT'),
  );
  return (
    <a
      href={dayUrl(day.date)}
      class="flex flex-col items-center gap-0.5 min-h-16 p-0.5 rounded-field overflow-hidden hover:bg-base-200"
      aria-label={[
        dayLabel(day.date),
        ...outfits,
        ...(worn ? [t('CALENDAR_WORN')] : []),
      ].join(', ')}
      aria-current={day.isToday ? 'date' : undefined}
      data-month-day={day.date}
      data-worn={worn ? '' : undefined}
    >
      <span
        class={`flex items-center justify-center size-6 rounded-full text-xs font-semibold ${day.isToday ? 'bg-primary text-primary-content' : ''}`}
      >
        {day.dayNum}
      </span>
      {first && (
        <span class="w-full">
          <OutfitCollage
            garments={bodyOf(first.outfit.garments)}
            size="thumb"
          />
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
