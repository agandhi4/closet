import type { IsoDate } from '../calendar/calendar-date';
import { todayIn } from '../calendar/calendar-date';
import { t, tKey } from '../i18n';
import type { ViewContext } from '../view-context';
import type { Condition } from '../../weather/forecast';
import type { TemperatureUnit } from '../../weather/temperature';
import type { DayChip, TodayLine } from './summary';

/**
 * The weather's pieces on other pages (#14). A page renders WeatherSlot in
 * its header and, on the calendar, a WeatherDaySlot per day; the slot loads
 * GET /weather/summary once in place (hx-trigger="load"), which answers the
 * WeatherLine (or the prompt to set a location) and, out of band, the day
 * chips. The month grid (#201) is the same load without the line:
 * WeatherMonthLoader asks for its forecast days' compact chips, which land
 * in each cell's WeatherCellSlot. Loading it separately keeps the pages' own HTML free of the weather:
 * a tab root must render byte for byte the same while nothing changes (the
 * service worker's revalidation, CLAUDE.md PWA), and a forecast refreshed
 * every hour would otherwise mark it changed. Offline, the service worker
 * answers the fragment from its cache, and the line says when it was
 * fetched ("as of 9:05 AM").
 */

export const WEATHER_LINE_ID = 'weather-line';

const ICONS: Readonly<Record<Condition, string>> = {
  clear: '☀️',
  'partly-cloudy': '⛅',
  cloudy: '☁️',
  fog: '🌫️',
  drizzle: '🌦️',
  rain: '🌧️',
  snow: '🌨️',
  thunderstorm: '⛈️',
};

export const UNIT_SYMBOLS: Readonly<Record<TemperatureUnit, string>> = {
  celsius: '°C',
  fahrenheit: '°F',
};

export const WEATHER_MONTH_ID = 'weather-month';

/**
 * Who asks: the header (the line, and the calendar week's chips) or the month
 * grid (its cells' compact chips alone, SummaryQuery's `view`).
 */
export type SummaryView = 'line' | 'month';

export function summaryUrl(
  days?: { from: IsoDate; to: IsoDate },
  view: SummaryView = 'line',
): string {
  if (!days) return '/weather/summary';
  const range = `/weather/summary?from=${days.from}&to=${days.to}`;
  return view === 'month' ? `${range}&view=month` : range;
}

/**
 * Where the line goes: nothing with WEATHER_ENABLED=false. Its own
 * hx-indicator, so this background load does not light the app bar's spinner
 * (the body's inherited one) on every page.
 */
export function WeatherSlot(props: {
  ctx: ViewContext;
  /** The calendar's week: its days' chips come with the line. */
  days?: { from: IsoDate; to: IsoDate };
}) {
  if (!props.ctx.weatherEnabled) return null;
  return (
    <div
      id={WEATHER_LINE_ID}
      class="min-h-5 mb-3 px-2"
      hx-get={summaryUrl(props.days)}
      hx-trigger="load"
      hx-swap="outerHTML"
      hx-indicator={`#${WEATHER_LINE_ID}`}
    ></div>
  );
}

/**
 * The month grid's weather: the summary for the grid's forecast days, loaded
 * once after the page like WeatherSlot, answering only the cells' chips (out
 * of band; `hx-swap="none"` keeps the fragment itself out of the page, so
 * no line appears and nothing above the grid moves). Nothing for a month the
 * forecast does not reach, so paging through the history asks for nothing.
 */
export function WeatherMonthLoader(props: {
  ctx: ViewContext;
  days: { from: IsoDate; to: IsoDate } | null;
}) {
  if (!props.ctx.weatherEnabled || !props.days) return null;
  return (
    <div
      id={WEATHER_MONTH_ID}
      hidden
      hx-get={summaryUrl(props.days, 'month')}
      hx-trigger="load"
      hx-swap="none"
      hx-indicator={`#${WEATHER_MONTH_ID}`}
    ></div>
  );
}

/** A day's chip's id, for its slot and for a cell's `aria-describedby`. */
export function weatherDayId(day: IsoDate): string {
  return `weather-day-${day}`;
}

/** A calendar day's place for its chip, filled out of band by the summary. */
export function WeatherDaySlot(props: { ctx: ViewContext; day: IsoDate }) {
  if (!props.ctx.weatherEnabled) return null;
  return <span id={weatherDayId(props.day)} class="ml-auto"></span>;
}

/**
 * The month cell's chip box: the slot and the chip that replaces it are the
 * same height, so a chip arriving moves nothing in the grid (#201).
 */
const CELL_CHIP_BOX = 'h-4 leading-4';

/** A month cell's place for its compact chip (WeatherCellDay). */
export function WeatherCellSlot(props: { ctx: ViewContext; day: IsoDate }) {
  if (!props.ctx.weatherEnabled) return null;
  return <span id={weatherDayId(props.day)} class={CELL_CHIP_BOX}></span>;
}

export function conditionLabel(condition: Condition): string {
  return tKey(`weather.condition.${condition}`);
}

/** A condition's icon with its name for screen readers (the line, the chips, a trip's days). */
export function ConditionIcon({ condition }: { condition: Condition }) {
  return (
    <span role="img" aria-label={conditionLabel(condition)}>
      {ICONS[condition]}
    </span>
  );
}

/** "3 pm". */
export function hourLabel(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return hour < 12
    ? t('weather.HOUR_AM', { hour: twelve })
    : t('weather.HOUR_PM', { hour: twelve });
}

/** "9:05 AM", or "Fri 9:05 AM" when it was not today (in APP_TIMEZONE). */
export function fetchedLabel(fetchedAt: Date, timeZone: string, now: Date) {
  const sameDay = todayIn(timeZone, fetchedAt) === todayIn(timeZone, now);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: sameDay ? undefined : 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(fetchedAt);
}

/**
 * Today's summary: "⛅ 12–18 °C · rain from 3 pm · take a layer", then
 * where and as of when (the forecast's fetch time, so a copy served from
 * the service worker's cache offline tells its age).
 */
export function WeatherLine(props: {
  line: TodayLine;
  timeZone: string;
  now: Date;
}) {
  const { line } = props;
  const notes = lineNotes(line);
  const asOf = t('weather.AS_OF', {
    time: fetchedLabel(line.fetchedAt, props.timeZone, props.now),
  });
  return (
    <p
      id={WEATHER_LINE_ID}
      class="flex flex-wrap items-baseline gap-x-2 mb-3 px-2 text-sm text-base-content/70"
    >
      <ConditionIcon condition={line.condition} />
      <span class="font-medium text-base-content">
        {t('weather.RANGE', {
          low: line.low,
          high: line.high,
          unit: UNIT_SYMBOLS[line.unit],
        })}
      </span>
      {notes.map((note) => (
        <span>· {note}</span>
      ))}
      <span class="text-xs text-muted">
        {line.place ?? t('weather.NEAR_YOU')} · {asOf}
      </span>
    </p>
  );
}

// "rain from 3 pm", "take a layer": what the line adds to the range.
function lineNotes(line: TodayLine): string[] {
  return [
    line.rainNow
      ? t('weather.RAIN_NOW')
      : line.rainFrom !== null
        ? t('weather.RAIN_FROM', { hour: hourLabel(line.rainFrom) })
        : null,
    line.layer ? t('weather.TAKE_LAYER') : null,
  ].filter((note) => note !== null);
}

/**
 * The line as plain text, "☀️ 12–18 °C · rain from 3 pm · take a layer",
 * for the morning push reminder (src/web/push/reminders.ts).
 */
export function weatherLineText(line: TodayLine): string {
  const range = t('weather.RANGE', {
    low: line.low,
    high: line.high,
    unit: UNIT_SYMBOLS[line.unit],
  });
  return [`${ICONS[line.condition]} ${range}`, ...lineNotes(line)].join(' · ');
}

/** No location yet: the line is the way to set one. */
export function WeatherPrompt() {
  return (
    <p id={WEATHER_LINE_ID} class="mb-3 px-2 text-sm">
      <a class="link link-hover text-muted" href="/auth/profile#weather">
        {t('weather.SET_LOCATION')}
      </a>
    </p>
  );
}

/** A calendar day's chip, swapped into its WeatherDaySlot out of band. */
export function WeatherDay({ chip }: { chip: DayChip }) {
  return (
    <span
      id={weatherDayId(chip.day)}
      hx-swap-oob="true"
      class="ml-auto flex items-baseline gap-1 text-xs text-muted"
      data-weather-day={chip.day}
    >
      <ConditionIcon condition={chip.condition} />
      {t('weather.DAY_RANGE', { low: chip.low, high: chip.high })}
    </span>
  );
}

/**
 * A month cell's chip, swapped into its WeatherCellSlot out of band: the
 * icon and the high alone. A cell is about 46 px wide at 390 px, where the
 * week's low–high range does not fit beside the icon; the high is the
 * figure a glance at the month is for (the week has the range).
 */
export function WeatherCellDay({ chip }: { chip: DayChip }) {
  return (
    <span
      id={weatherDayId(chip.day)}
      hx-swap-oob="true"
      class={`${CELL_CHIP_BOX} flex items-center gap-0.5 text-xs whitespace-nowrap text-muted`}
      data-weather-day={chip.day}
    >
      <ConditionIcon condition={chip.condition} />
      {t('weather.DAY_HIGH', { high: chip.high })}
    </span>
  );
}
