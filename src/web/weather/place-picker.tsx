import { type Static, Type } from '@sinclair/typebox';
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { type Location, roundedLocation } from '../../weather/location';
import { t } from '../i18n';
import type { Place } from './open-meteo';
import type { WeatherService } from './service';

/**
 * The place-search protocol both pickers share (the profile's home city,
 * src/web/weather/settings.tsx, and a trip's destination,
 * src/web/trips/weather.tsx): the search field's bounds and its query
 * schema, the answer, the list of places with their posted fields, and the
 * schemas those posts are read with. `@place-fields` (scripts/ci/guards.conf)
 * keeps the posted coordinates here; each picker brings only where a pick
 * goes.
 */

/** The search field's `minlength`/`maxlength`, which PlaceQuery holds the server to. */
export const PLACE_QUERY_MIN = 2;
export const PLACE_QUERY_MAX = 100;
const PLACE_NAME_MAX = 200;

export const PlaceQuery = Type.Object({
  q: Type.String({ minLength: PLACE_QUERY_MIN, maxLength: PLACE_QUERY_MAX }),
});

/** A position as posted: the phone's (public/js/locate.js) or a picked place's. */
export const LocationBody = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
});

/** A place picked from the search's answer (PlaceResults' fields). */
export const PlaceBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: PLACE_NAME_MAX }),
  ...LocationBody.properties,
});

export function postedLocation(body: Static<typeof LocationBody>): Location {
  // In range by the schema, so never null.
  return roundedLocation(body.latitude, body.longitude)!;
}

export function pickedPlace(body: Static<typeof PlaceBody>): {
  name: string;
  location: Location;
} {
  return { name: body.name.trim(), location: postedLocation(body) };
}

export type PlaceAnswer = { places: Place[] } | { failed: true };

/** The geocoding search's answer; a failure (logged by the service) is an answer too. */
export async function placeAnswer(
  weather: WeatherService,
  query: Static<typeof PlaceQuery>,
): Promise<PlaceAnswer> {
  try {
    return { places: await weather.searchPlaces(query.q.trim()) };
  } catch {
    return { failed: true };
  }
}

/**
 * A position's hidden fields, empty for locate.js to fill when `location`
 * is absent.
 */
export function LocationFields(props: { location?: Location }) {
  const { location } = props;
  return (
    <>
      <input
        type="hidden"
        name="latitude"
        value={location && String(location.latitude)}
      />
      <input
        type="hidden"
        name="longitude"
        value={location && String(location.longitude)}
      />
    </>
  );
}

/**
 * The search's answer (a 200 either way, so htmx shows it): a button per
 * place, each in a `Form` of the picker's, posting PlaceBody's fields.
 */
export function PlaceResults(props: {
  answer: PlaceAnswer;
  Form: (props: { children: Child }) => JSX.Element;
}) {
  const { answer, Form } = props;
  if ('failed' in answer) {
    return <p class="text-sm text-error">{t('weather.SEARCH_FAILED')}</p>;
  }
  if (answer.places.length === 0) {
    return <p class="text-sm">{t('weather.NO_PLACES')}</p>;
  }
  return (
    <ul class="flex flex-col gap-1">
      {answer.places.map((place) => (
        <li>
          <Form>
            <input type="hidden" name="name" value={place.label} />
            <LocationFields location={place.location} />
            <button
              type="submit"
              class="btn btn-ghost btn-sm justify-start w-full"
            >
              {place.label}
            </button>
          </Form>
        </li>
      ))}
    </ul>
  );
}
