import type { Db } from '../../db/client';
import {
  type DayForecast,
  FORECAST_DAYS,
  forecastDay,
} from '../../weather/forecast';
import { type WeatherNeeds, weatherNeeds } from '../../weather/match';
import type { TemperatureUnit } from '../../weather/temperature';
import { addDays, type IsoDate } from '../calendar/calendar-date';
import { findWeatherSettings } from '../weather/queries';
import type { WeatherService } from '../weather/service';
import type { TripRow } from './queries';

/**
 * A trip's weather (#10 over #14; plan section 7, "a trip's destination,
 * geocoded, gives that trip its forecast"): the destination's forecast
 * through the same service and cache as the home's (forecastFor, one row
 * per rounded location), for the trip's days the 16-day forecast reaches,
 * each with what it asks of an all-day outfit (the matching, the person's
 * own offset). Days past the forecast get no weather: climate normals (the
 * plan's "typical" days) are deferred with #14's hook in open-meteo.ts, so
 * the page says from when each later day will have its forecast. Nothing is
 * fetched for a trip without a located destination, one that is over, or one
 * that starts past the forecast. Read by the trip page's fragment and
 * get_trip; never rendered into the page itself (a forecast refreshed hourly
 * would make the page wait on Open-Meteo).
 */

export interface TripWeatherDay {
  forecast: DayForecast;
  /** What the day asks of an all-day outfit; null without its hours. */
  needs: WeatherNeeds | null;
}

export type TripForecast =
  | { kind: 'no-location' }
  | { kind: 'over' }
  /** Open-Meteo has never answered for the place. */
  | { kind: 'unavailable' }
  | {
      kind: 'forecast';
      days: TripWeatherDay[];
      /**
       * The first trip day past the forecast and the day its forecast
       * arrives (FORECAST_DAYS - 1 days before it); null when every day is
       * covered.
       */
      later: { day: IsoDate; from: IsoDate } | null;
      unit: TemperatureUnit;
      /** The person's offset (°C), already in `needs`. */
      offset: number;
      fetchedAt: Date | null;
    };

/** The trip's first day past the forecast's `horizon`, and when its forecast arrives. */
function laterDays(
  trip: { startsOn: IsoDate; endsOn: IsoDate },
  horizon: IsoDate,
): { day: IsoDate; from: IsoDate } | null {
  const pastHorizon = addDays(horizon, 1);
  if (trip.endsOn < pastHorizon) return null;
  const day = trip.startsOn > pastHorizon ? trip.startsOn : pastHorizon;
  return { day, from: addDays(day, -(FORECAST_DAYS - 1)) };
}

export async function tripForecast(
  deps: { db: Db; weather: WeatherService },
  ownerId: number,
  trip: TripRow,
  today: IsoDate,
): Promise<TripForecast> {
  if (trip.endsOn < today) return { kind: 'over' };
  if (!trip.location) return { kind: 'no-location' };
  const horizon = addDays(today, FORECAST_DAYS - 1);
  const first = trip.startsOn > today ? trip.startsOn : today;
  const last = trip.endsOn < horizon ? trip.endsOn : horizon;
  const later = laterDays(trip, horizon);
  const settings = await findWeatherSettings(deps.db, ownerId);
  if (first > last) {
    // It starts past the forecast: nothing to fetch yet.
    return {
      kind: 'forecast',
      days: [],
      later,
      unit: settings.unit,
      offset: settings.offset,
      fetchedAt: null,
    };
  }
  const cached = await deps.weather.forecastFor(trip.location);
  if (!cached) return { kind: 'unavailable' };
  const days: TripWeatherDay[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const forecast = forecastDay(cached.forecast, day);
    if (forecast) {
      days.push({
        forecast,
        needs: weatherNeeds(forecast, 'all-day', settings.offset),
      });
    }
  }
  return {
    kind: 'forecast',
    days,
    later,
    unit: settings.unit,
    offset: settings.offset,
    fetchedAt: cached.fetchedAt,
  };
}
