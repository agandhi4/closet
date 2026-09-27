import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import {
  addDays,
  daysBetween,
  hourIn,
  type IsoDate,
  todayIn,
} from '../calendar/calendar-date';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { renderFragment } from '../render';
import { IsoDateSchema } from '../schemas';
import { WEATHER_SEARCH_LIMIT } from '../security/rate-limit';
import { roundedLocation } from '../../weather/location';
import { FEELINGS, TEMPERATURE_UNITS } from '../../weather/temperature';
import {
  clearHere,
  clearHome,
  findWeatherSettings,
  type WeatherSettings as WeatherSettingsRow,
  nudgeTemperatureOffset,
  resetTemperatureOffset,
  setHere,
  setHome,
  setTemperatureUnit,
} from './queries';
import { userWeather, type WeatherService } from './service';
import {
  OffsetControls,
  PlaceResults,
  WEATHER_SETTINGS_ID,
  WeatherLocation,
} from './settings';
import { dayChips, todayLine } from './summary';
import { WeatherDay, WeatherLine, WeatherPrompt } from './views';

/** The widest range of day chips one summary answers: a calendar month and a half. */
const MAX_SUMMARY_DAYS = 42;
export const PLACE_NAME_MAX = 200;
export const PLACE_QUERY_MAX = 100;

const Latitude = Type.Number({ minimum: -90, maximum: 90 });
const Longitude = Type.Number({ minimum: -180, maximum: 180 });

const SummaryQuery = Type.Object({
  from: Type.Optional(IsoDateSchema),
  to: Type.Optional(IsoDateSchema),
});

/**
 * The calendar days a summary gives chips to: none without a range, 400 for
 * half a range, a backward one or one past MAX_SUMMARY_DAYS (the calendar
 * page builds the URL, so anything else is not ours).
 */
function summaryDays(from: IsoDate | undefined, to: IsoDate | undefined) {
  if (from === undefined && to === undefined) return [];
  if (from === undefined || to === undefined) {
    throw new HttpError(400, 'Give both from and to, or neither');
  }
  const span = daysBetween(from, to) + 1;
  if (span < 1 || span > MAX_SUMMARY_DAYS) {
    throw new HttpError(
      400,
      `Ask for 1 to ${MAX_SUMMARY_DAYS} days, from before to`,
    );
  }
  return Array.from({ length: span }, (_, i) => addDays(from, i));
}

export interface WeatherRouteOptions extends WebOptions {
  weather: WeatherService;
}

/**
 * The weather (#14; plan section 7), registered by webPlugin only when
 * WEATHER_ENABLED (otherwise every /weather path is a 404, and so nothing
 * can store a location). The signed-in user's own settings and forecast;
 * shares never reach them.
 *
 * - GET /weather/summary[?from=&to=]: the header line (WeatherLine, or
 *   the prompt to set a location) and, for a calendar's days, their chips
 *   out of band. Always a fragment: the pages load it in place.
 * - GET /weather/places?q=: the city search (Open-Meteo geocoding through
 *   the server), WEATHER_SEARCH_LIMIT. `secretPath`: the request log shows
 *   the route, never the typed city.
 * - POST /weather/home, /home/clear, /here, /here/clear, /unit, /feedback,
 *   /offset/reset: the profile's settings, each answering to htmx the part
 *   of the section it changed (the location, the offset; the unit its status
 *   line and the offset) or a 303 to the profile. Coordinates are rounded
 *   before they are stored; the logs name the user, never a location.
 */
export const weatherRoutes: FastifyPluginCallbackTypebox<
  WeatherRouteOptions
> = (app, { db, config, logger, weather }, done) => {
  /**
   * To htmx, the part of the settings section a write changed (`part`, from
   * the user's settings); to a plain post, the profile. Never the whole
   * section: it holds the unit's AutosaveForm (src/web/weather/settings.tsx).
   */
  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    part: (settings: WeatherSettingsRow) => JSX.Element,
  ) {
    if (!request.headers['hx-request']) {
      return reply.redirect(`/auth/profile#${WEATHER_SETTINGS_ID}`, 303);
    }
    const settings = await findWeatherSettings(db, sessionUserId(request));
    return renderFragment(reply, part(settings));
  }
  const locationPart = (settings: WeatherSettingsRow) => (
    <WeatherLocation
      settings={settings}
      timeZone={config.timeZone}
      now={new Date()}
    />
  );
  const offsetPart = (settings: WeatherSettingsRow) => (
    <OffsetControls settings={settings} />
  );
  // The unit's AutosaveForm: its status line, and the offset, which reads in
  // the unit, out of band.
  const unitSaved = (settings: WeatherSettingsRow) => (
    <>
      <AutosaveSaved />
      <OffsetControls settings={settings} oob />
    </>
  );

  app.get(
    '/weather/summary',
    { schema: { querystring: SummaryQuery } },
    async (request, reply) => {
      const days = summaryDays(request.query.from, request.query.to);
      const now = new Date();
      const { settings, active, cached } = await userWeather(
        db,
        weather,
        sessionUserId(request),
        now,
      );
      if (!active) return renderFragment(reply, <WeatherPrompt />);
      if (!cached) return renderFragment(reply, <></>);
      const line = todayLine({
        cached,
        active,
        settings,
        today: todayIn(config.timeZone, now),
        hour: hourIn(config.timeZone, now),
      });
      return renderFragment(
        reply,
        <>
          {line && (
            <WeatherLine line={line} timeZone={config.timeZone} now={now} />
          )}
          {dayChips(cached, days, settings.unit).map((chip) => (
            <WeatherDay chip={chip} />
          ))}
        </>,
      );
    },
  );

  app.get(
    '/weather/places',
    {
      schema: {
        querystring: Type.Object({
          q: Type.String({ minLength: 2, maxLength: PLACE_QUERY_MAX }),
        }),
      },
      config: { rateLimit: WEATHER_SEARCH_LIMIT, secretPath: true },
    },
    async (request, reply) => {
      try {
        const places = await weather.searchPlaces(request.query.q.trim());
        return renderFragment(reply, <PlaceResults places={places} />);
      } catch {
        // Logged by the service. A 200, so htmx shows it.
        return renderFragment(reply, <PlaceResults failed />);
      }
    },
  );

  app.post(
    '/weather/home',
    {
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: PLACE_NAME_MAX }),
          latitude: Latitude,
          longitude: Longitude,
        }),
      },
    },
    async (request, reply) => {
      const { name, latitude, longitude } = request.body;
      const userId = sessionUserId(request);
      await setHome(db, userId, {
        name: name.trim(),
        // In range by the schema, so never null.
        location: roundedLocation(latitude, longitude)!,
      });
      logger.info(`Weather home set by user ${userId}`);
      return answer(request, reply, locationPart);
    },
  );

  app.post('/weather/home/clear', async (request, reply) => {
    const userId = sessionUserId(request);
    await clearHome(db, userId);
    logger.info(`Weather home removed by user ${userId}`);
    return answer(request, reply, locationPart);
  });

  app.post(
    '/weather/here',
    {
      schema: {
        body: Type.Object({ latitude: Latitude, longitude: Longitude }),
      },
    },
    async (request, reply) => {
      const { latitude, longitude } = request.body;
      const userId = sessionUserId(request);
      await setHere(
        db,
        userId,
        roundedLocation(latitude, longitude)!,
        new Date(),
      );
      logger.info(`Weather location (this phone's) set by user ${userId}`);
      return answer(request, reply, locationPart);
    },
  );

  app.post('/weather/here/clear', async (request, reply) => {
    const userId = sessionUserId(request);
    await clearHere(db, userId);
    logger.info(`Weather location (this phone's) removed by user ${userId}`);
    return answer(request, reply, locationPart);
  });

  app.post(
    '/weather/unit',
    {
      schema: {
        body: Type.Object({
          unit: Type.Union(TEMPERATURE_UNITS.map((u) => Type.Literal(u))),
        }),
      },
    },
    async (request, reply) => {
      const userId = sessionUserId(request);
      await setTemperatureUnit(db, userId, request.body.unit);
      logger.info(
        `Temperature unit set to ${request.body.unit} by user ${userId}`,
      );
      return answer(request, reply, unitSaved);
    },
  );

  app.post(
    '/weather/feedback',
    {
      schema: {
        body: Type.Object({
          feeling: Type.Union(FEELINGS.map((f) => Type.Literal(f))),
        }),
      },
    },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const offset = await nudgeTemperatureOffset(
        db,
        userId,
        request.body.feeling,
      );
      logger.info(
        `Temperature feedback from user ${userId}: ${request.body.feeling}, offset now ${offset}`,
      );
      return answer(request, reply, offsetPart);
    },
  );

  app.post('/weather/offset/reset', async (request, reply) => {
    const userId = sessionUserId(request);
    await resetTemperatureOffset(db, userId);
    logger.info(`Temperature offset reset by user ${userId}`);
    return answer(request, reply, offsetPart);
  });

  done();
};
