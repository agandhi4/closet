import { type Static, Type } from '@sinclair/typebox';
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  type Location,
  type PickedLocation,
  roundedLocation,
} from '../../weather/location';
import { canonicalTimeZone } from '../../calendar-date';
import { t } from '../i18n';
import type { Place } from './open-meteo';
import type { WeatherService } from './service';

/**
 * The place-search protocol the pickers share (the profile's home city,
 * src/web/weather/settings.tsx, a trip's destination,
 * src/web/trips/weather.tsx, and the new-trip form's, form-page.tsx, #684):
 * the search field's bounds and its query
 * schema, the answer, the list of places with their posted fields, and the
 * schemas those posts are read with. `@place-fields` (scripts/ci/guards.conf)
 * keeps the posted coordinates here; each picker brings only where a pick
 * goes.
 */

/** The search field's `minlength`/`maxlength`, which PlaceQuery holds the server to. */
export const PLACE_QUERY_MIN = 2;
export const PLACE_QUERY_MAX = 100;
const PLACE_NAME_MAX = 200;
// The longest IANA name is about 30 characters ("America/Argentina/ComodRivadavia").
const TIME_ZONE_MAX = 64;

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
  // The search answer's zone (#678): a trip's days are asked in it. Absent
  // (a form cached before it), null (the search's answer for a place that
  // named none, which API clients send back as it came, #807) or a name
  // Intl does not know is no zone, never a 400: the weather reads
  // APP_TIMEZONE then, as it did before.
  timeZone: Type.Optional(
    Type.Union([Type.String({ maxLength: TIME_ZONE_MAX }), Type.Null()]),
  ),
});

export function postedLocation(body: Static<typeof LocationBody>): Location {
  // In range by the schema, so never null.
  return roundedLocation(body.latitude, body.longitude)!;
}

/** A place as a picker keeps it: the trip's destination, the profile's home. */
export interface PickedPlace {
  name: string;
  location: PickedLocation;
}

export function pickedPlace(body: Static<typeof PlaceBody>): PickedPlace {
  const timeZone =
    body.timeZone == null ? null : canonicalTimeZone(body.timeZone);
  return {
    name: body.name.trim(),
    location: { ...postedLocation(body), timeZone },
  };
}

/**
 * A picked place as the API answers it kept (KeptPlace, the home's PUT and
 * a trip destination's): the name and the rounded coordinates. Not the zone:
 * the home is always read in APP_TIMEZONE (#678).
 */
export function keptPlace(place: PickedPlace): {
  name: string;
  latitude: number;
  longitude: number;
} {
  const { latitude, longitude } = place.location;
  return { name: place.name, latitude, longitude };
}

/**
 * A trip destination as the API answers it kept: KeptPlace plus the zone as
 * saved, null when the sent one was absent, null or unknown (so the caller
 * sees the fallback to APP_TIMEZONE, #808).
 */
export function keptDestination(place: PickedPlace) {
  return { ...keptPlace(place), timeZone: place.location.timeZone };
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

/** A picked place's coordinates and zone as hidden fields, without its name (each picker posts that as it names it). */
export function PlaceLocationFields(props: { location: PickedLocation }) {
  const { location } = props;
  return (
    <>
      <LocationFields location={location} />
      {location.timeZone && (
        <input type="hidden" name="timeZone" value={location.timeZone} />
      )}
    </>
  );
}

/** How a picker offers one place of the search's answer. */
export type PlacePick = (props: { place: Place }) => JSX.Element;

/**
 * The search's answer (a 200 either way, so htmx shows it): a control per
 * place, the picker's `Pick`.
 */
export function PlaceResults(props: { answer: PlaceAnswer; Pick: PlacePick }) {
  const { answer, Pick } = props;
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
          <Pick place={place} />
        </li>
      ))}
    </ul>
  );
}

const PICK_BUTTON = 'btn btn-ghost btn-sm justify-start w-full';

/** A pick that posts PlaceBody's fields in the picker's own form. */
export function postedPick(
  Form: (props: { children: Child }) => JSX.Element,
): PlacePick {
  return ({ place }) => (
    <Form>
      <input type="hidden" name="name" value={place.label} />
      <PlaceLocationFields
        location={{ ...place.location, timeZone: place.timeZone }}
      />
      <button type="submit" class={PICK_BUTTON}>
        {place.label}
      </button>
    </Form>
  );
}

/**
 * A pick for a picker inside a form of its own, which cannot nest one (the
 * new-trip form): a button asking `path` by GET with PlaceBody's fields as
 * the query, its answer swapped over `target`. Writes nothing: the form's
 * post carries the place.
 */
export function fetchedPick(path: string, target: string): PlacePick {
  return ({ place }) => {
    const query = new URLSearchParams({
      name: place.label,
      latitude: String(place.location.latitude),
      longitude: String(place.location.longitude),
    });
    if (place.timeZone) query.set('timeZone', place.timeZone);
    return (
      <button
        type="button"
        class={PICK_BUTTON}
        hx-get={`${path}?${query}`}
        hx-target={target}
        hx-swap="outerHTML"
      >
        {place.label}
      </button>
    );
  };
}
