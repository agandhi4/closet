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
 * chips. Loading it separately keeps the pages' own HTML free of the weather:
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

export function summaryUrl(days?: { from: IsoDate; to: IsoDate }): string {
  return days
    ? `/weather/summary?from=${days.from}&to=${days.to}`
    : '/weather/summary';
}

/**
 * Where the line goes: nothing with WEATHER_ENABLED=false. Its own
 * hx-indicator, so this background load does not light the navbar spinner
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

function dayChipId(day: IsoDate): string {
  return `weather-day-${day}`;
}

/** A calendar day's place for its chip, filled out of band by the summary. */
export function WeatherDaySlot(props: { ctx: ViewContext; day: IsoDate }) {
  if (!props.ctx.weatherEnabled) return null;
  return <span id={dayChipId(props.day)} class="ml-auto"></span>;
}

export function conditionLabel(condition: Condition): string {
  return tKey(`weather.condition.${condition}`);
}

function Icon({ condition }: { condition: Condition }) {
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
  const notes = [
    line.rainNow
      ? t('weather.RAIN_NOW')
      : line.rainFrom !== null
        ? t('weather.RAIN_FROM', { hour: hourLabel(line.rainFrom) })
        : null,
    line.layer ? t('weather.TAKE_LAYER') : null,
  ].filter((note) => note !== null);
  const asOf = t('weather.AS_OF', {
    time: fetchedLabel(line.fetchedAt, props.timeZone, props.now),
  });
  return (
    <p
      id={WEATHER_LINE_ID}
      class="flex flex-wrap items-baseline gap-x-2 mb-3 px-2 text-sm text-base-content/70"
    >
      <Icon condition={line.condition} />
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
      <span class="text-xs text-base-content/50">
        {line.place ?? t('weather.NEAR_YOU')} · {asOf}
      </span>
    </p>
  );
}

/** No location yet: the line is the way to set one. */
export function WeatherPrompt() {
  return (
    <p id={WEATHER_LINE_ID} class="mb-3 px-2 text-sm">
      <a
        class="link link-hover text-base-content/60"
        href="/auth/profile#weather"
      >
        {t('weather.SET_LOCATION')}
      </a>
    </p>
  );
}

/** A calendar day's chip, swapped into its WeatherDaySlot out of band. */
export function WeatherDay({ chip }: { chip: DayChip }) {
  return (
    <span
      id={dayChipId(chip.day)}
      hx-swap-oob="true"
      class="ml-auto flex items-baseline gap-1 text-xs text-base-content/60"
      data-weather-day={chip.day}
    >
      <Icon condition={chip.condition} />
      {t('weather.DAY_RANGE', { low: chip.low, high: chip.high })}
    </span>
  );
}
