import type { Db } from '../../db/client';
import {
  type DayForecast,
  FORECAST_DAYS,
  forecastDay,
} from '../../weather/forecast';
import { type WeatherNeeds, weatherNeeds } from '../../weather/match';
import { type DayNormals, normalsOn, typicalDay } from '../../weather/normals';
import type { TemperatureUnit } from '../../weather/temperature';
import { addDays, type IsoDate } from '../calendar/calendar-date';
import { findWeatherSettings } from '../weather/queries';
import type {
  CachedForecast,
  CachedNormals,
  WeatherService,
} from '../weather/service';
import type { TripRow } from './queries';

/**
 * A trip's weather (#10 over #14; plan section 7, "a trip's destination,
 * geocoded, gives that trip its forecast"): the destination's forecast
 * through the same service and cache as the home's (forecastFor, one row
 * per rounded location), for the trip's days the 16-day forecast reaches,
 * each with what it asks of an all-day outfit (the matching, the person's
 * own offset). Days past the forecast get the place's climate normals
 * instead (normalsFor; "typical", never called a forecast), each judged
 * through a typical day (src/weather/normals.ts, typicalDay) the same way,
 * and the page says from when each later day will have its forecast.
 * Nothing is fetched for a trip without a located destination or one that
 * is over; one that starts past the forecast fetches only the normals.
 * Read by the trip page's fragment and get_trip; never rendered into the
 * page itself (a forecast refreshed hourly would make the page wait on
 * Open-Meteo).
 */

export interface TripWeatherDay {
  forecast: DayForecast;
  /** What the day asks of an all-day outfit; null without its hours. */
  needs: WeatherNeeds | null;
}

/** A day past the forecast: what the destination is usually like then. */
export interface TripTypicalDay {
  day: IsoDate;
  normals: DayNormals;
  /** What a typical day asks of an all-day outfit (typicalDay, the offset). */
  needs: WeatherNeeds | null;
}

/** The first trip day past the forecast, and the day its forecast arrives. */
export interface TripForecastLater {
  day: IsoDate;
  from: IsoDate;
}

export type TripForecast =
  | { kind: 'no-location' }
  | { kind: 'over' }
  | {
      kind: 'forecast';
      days: TripWeatherDay[];
      /**
       * Some trip days are within the forecast, but Open-Meteo has never
       * answered it for the place (`days` is empty). The typical days past
       * it are their own answer and still show.
       */
      unavailable: boolean;
      /**
       * The days past the forecast with the place's normals, in order; empty
       * when none are past it or the normals are not available.
       */
      typical: TripTypicalDay[];
      /** The first trip day past the forecast; null when every day is covered. */
      later: TripForecastLater | null;
      unit: TemperatureUnit;
      /** The person's offset (°C), already in `needs`. */
      offset: number;
      /** When the forecast was fetched; null when no day is within it. */
      fetchedAt: Date | null;
    };

interface DaySpan {
  first: IsoDate;
  last: IsoDate;
}

/**
 * The trip's days from today the forecast reaches (null: none), and the
 * first day past it with the day its forecast arrives (FORECAST_DAYS - 1
 * days before it; null: every day is covered).
 */
function tripSpan(
  trip: { startsOn: IsoDate; endsOn: IsoDate },
  today: IsoDate,
): { within: DaySpan | null; later: TripForecastLater | null } {
  const horizon = addDays(today, FORECAST_DAYS - 1);
  const first = trip.startsOn > today ? trip.startsOn : today;
  const last = trip.endsOn < horizon ? trip.endsOn : horizon;
  const pastHorizon = addDays(horizon, 1);
  const laterDay = trip.startsOn > pastHorizon ? trip.startsOn : pastHorizon;
  return {
    within: first <= last ? { first, last } : null,
    later:
      trip.endsOn < pastHorizon
        ? null
        : { day: laterDay, from: addDays(laterDay, -(FORECAST_DAYS - 1)) },
  };
}

export async function tripForecast(
  deps: { db: Db; weather: WeatherService },
  ownerId: number,
  trip: TripRow,
  today: IsoDate,
): Promise<TripForecast> {
  if (trip.endsOn < today) return { kind: 'over' };
  const { location } = trip;
  if (!location) return { kind: 'no-location' };
  const { within, later } = tripSpan(trip, today);
  const [settings, cached, normals] = await Promise.all([
    findWeatherSettings(deps.db, ownerId),
    // Nothing is fetched for a part of the trip that is not there.
    within && deps.weather.forecastFor(location),
    later && deps.weather.normalsFor(location),
  ]);
  const { offset, unit } = settings;
  return {
    kind: 'forecast',
    days: forecastDays(cached, within, offset),
    unavailable: within !== null && !cached,
    typical: typicalDays(normals, later, trip.endsOn, offset),
    later,
    unit,
    offset,
    fetchedAt: cached?.fetchedAt ?? null,
  };
}

/** The forecast's days in `span`, each with what it asks. */
function forecastDays(
  cached: CachedForecast | null,
  span: DaySpan | null,
  offset: number,
): TripWeatherDay[] {
  const days: TripWeatherDay[] = [];
  if (!cached || !span) return days;
  for (let day = span.first; day <= span.last; day = addDays(day, 1)) {
    const found = forecastDay(cached.forecast, day);
    if (found) {
      days.push({
        forecast: found,
        needs: weatherNeeds(found, 'all-day', offset),
      });
    }
  }
  return days;
}

/** The days from `later` to `last` with normals, each with what a typical day asks. */
function typicalDays(
  cached: CachedNormals | null,
  later: TripForecastLater | null,
  last: IsoDate,
  offset: number,
): TripTypicalDay[] {
  const days: TripTypicalDay[] = [];
  if (!cached || !later) return days;
  for (let day = later.day; day <= last; day = addDays(day, 1)) {
    const dayNormals = normalsOn(cached.normals, day);
    if (dayNormals) {
      days.push({
        day,
        normals: dayNormals,
        needs: weatherNeeds(typicalDay(day, dayNormals), 'all-day', offset),
      });
    }
  }
  return days;
}
