import { t } from '../i18n';
import {
  displayDifference,
  OFFSET_LIMIT,
  TEMPERATURE_UNITS,
} from '../../weather/temperature';
import type { Place } from './open-meteo';
import {
  activeLocation,
  HERE_FRESH_HOURS,
  type WeatherSettings,
} from './queries';
import { fetchedLabel } from './views';

/**
 * The profile's weather section (#14; the redesign's Profile slots it in
 * unchanged, docs/plans/2026-09-26-redesign.md): the home city (a search on
 * Open-Meteo's geocoding, through the server), "Use my location" (the
 * phone's position, rounded to 2 decimals in the browser and again on the
 * server; public/js/locate.js), the unit, and the personal temperature
 * offset with its "too warm" and "too cold" feedback (the minimal form of
 * #9's "say why not"). Every form posts to /weather/* and gets this section
 * back (src/web/weather/routes.tsx); each is disabled offline.
 */

export const WEATHER_SETTINGS_ID = 'weather';

const SWAP = {
  'hx-target': `#${WEATHER_SETTINGS_ID}`,
  'hx-swap': 'outerHTML',
  'data-needs-network': '',
} as const;

// A fixed module string (never a value): runs each time the section is
// swapped in, so the new button is wired (an inline module, not a
// <script src>, which would run once per document).
const LOCATE_MODULE = `import { initLocate } from 'locate';
initLocate(document.getElementById('${WEATHER_SETTINGS_ID}'));`;

export function WeatherSettings(props: {
  settings: WeatherSettings;
  timeZone: string;
  now: Date;
}) {
  const { settings, timeZone, now } = props;
  const active = activeLocation(settings, now);
  const here = active?.source === 'here' ? settings.here : null;
  return (
    <section
      id={WEATHER_SETTINGS_ID}
      class="card bg-base-200 w-full max-w-sm"
      aria-labelledby="weather-heading"
    >
      <div class="card-body gap-3">
        <h2 id="weather-heading" class="card-title">
          {t('weather.SETTINGS_HEADING')}
        </h2>
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm">
            {settings.home
              ? t('weather.HOME_IS', { name: settings.home.name })
              : t('weather.NO_HOME')}
          </p>
          {settings.home && (
            <form hx-post="/weather/home/clear" {...SWAP}>
              <button
                type="submit"
                class="btn btn-ghost btn-xs"
                aria-label={t('weather.REMOVE_HOME_LABEL')}
              >
                {t('weather.REMOVE_HOME')}
              </button>
            </form>
          )}
        </div>
        <form
          class="join w-full"
          role="search"
          hx-get="/weather/places"
          hx-target="#weather-places"
          hx-swap="innerHTML"
          data-needs-network=""
        >
          <input
            type="search"
            name="q"
            required
            minlength={2}
            maxlength={100}
            autocomplete="address-level2"
            class="input join-item w-full"
            placeholder={t('weather.SEARCH_PLACEHOLDER')}
            aria-label={t('weather.SEARCH_PLACEHOLDER')}
          />
          <button type="submit" class="btn join-item">
            {t('weather.SEARCH')}
          </button>
        </form>
        <div id="weather-places" aria-live="polite"></div>

        <HereControls
          locatedAt={here?.locatedAt ?? null}
          timeZone={timeZone}
          now={now}
        />

        <form
          hx-post="/weather/unit"
          hx-trigger="change"
          {...SWAP}
          class="flex items-center gap-2"
        >
          <span class="text-sm">{t('weather.UNIT')}</span>
          {TEMPERATURE_UNITS.map((unit) => (
            <input
              type="radio"
              name="unit"
              value={unit}
              class="btn btn-sm rounded-full"
              aria-label={t(
                unit === 'celsius' ? 'weather.CELSIUS' : 'weather.FAHRENHEIT',
              )}
              checked={settings.unit === unit}
            />
          ))}
        </form>

        <OffsetControls settings={settings} />
      </div>
      <script
        type="module"
        // A fixed string (LOCATE_MODULE), no value spliced in.
        dangerouslySetInnerHTML={{ __html: LOCATE_MODULE }}
      />
    </section>
  );
}

function HereControls(props: {
  locatedAt: Date | null;
  timeZone: string;
  now: Date;
}) {
  const { locatedAt, timeZone, now } = props;
  if (locatedAt) {
    const until = new Date(locatedAt.getTime() + HERE_FRESH_HOURS * 3_600_000);
    return (
      <div class="flex flex-col gap-1">
        <p class="text-sm">
          {t('weather.USING_HERE', {
            since: fetchedLabel(locatedAt, timeZone, now),
            until: fetchedLabel(until, timeZone, now),
          })}
        </p>
        <form hx-post="/weather/here/clear" {...SWAP}>
          <button type="submit" class="btn btn-ghost btn-xs">
            {t('weather.STOP_HERE')}
          </button>
        </form>
      </div>
    );
  }
  // locate.js shows the button where the browser can locate (a secure
  // context with Geolocation) and posts the rounded position through the
  // hidden form.
  return (
    <div class="flex flex-col gap-1" data-needs-network="">
      <button
        type="button"
        class="btn btn-outline btn-sm self-start"
        data-locate=""
        hidden
      >
        {t('weather.USE_HERE')}
      </button>
      <p
        class="text-xs text-error"
        role="alert"
        data-locate-status=""
        data-denied={t('weather.HERE_DENIED')}
        data-failed={t('weather.HERE_FAILED')}
        hidden
      ></p>
      <form id="weather-here-form" hx-post="/weather/here" {...SWAP} hidden>
        <input type="hidden" name="latitude" />
        <input type="hidden" name="longitude" />
      </form>
    </div>
  );
}

function OffsetControls({ settings }: { settings: WeatherSettings }) {
  // "as if it were 1.5° colder": the direction is in the words.
  const degrees = `${Math.abs(displayDifference(settings.offset, settings.unit))}°`;
  return (
    <div class="flex flex-col gap-2">
      <p class="text-sm">
        {settings.offset === 0
          ? t('weather.OFFSET_NONE')
          : t(
              settings.offset > 0
                ? 'weather.OFFSET_WARM'
                : 'weather.OFFSET_COLD',
              {
                degrees,
              },
            )}
      </p>
      <div class="flex flex-wrap gap-2">
        {(['too-warm', 'too-cold'] as const).map((feeling) => (
          <form hx-post="/weather/feedback" {...SWAP}>
            <input type="hidden" name="feeling" value={feeling} />
            <button
              type="submit"
              class="btn btn-sm btn-outline"
              disabled={
                feeling === 'too-warm'
                  ? settings.offset >= OFFSET_LIMIT
                  : settings.offset <= -OFFSET_LIMIT
              }
            >
              {t(
                feeling === 'too-warm'
                  ? 'weather.TOO_WARM'
                  : 'weather.TOO_COLD',
              )}
            </button>
          </form>
        ))}
        {settings.offset !== 0 && (
          <form hx-post="/weather/offset/reset" {...SWAP}>
            <button type="submit" class="btn btn-sm btn-ghost">
              {t('weather.OFFSET_RESET')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** GET /weather/places's answer: a button per place, each setting it as home. */
export function PlaceResults(props: { places: Place[] } | { failed: true }) {
  if ('failed' in props) {
    return <p class="text-sm text-error">{t('weather.SEARCH_FAILED')}</p>;
  }
  if (props.places.length === 0) {
    return <p class="text-sm">{t('weather.NO_PLACES')}</p>;
  }
  return (
    <ul class="flex flex-col gap-1">
      {props.places.map((place) => (
        <li>
          <form hx-post="/weather/home" {...SWAP}>
            <input type="hidden" name="name" value={place.label} />
            <input
              type="hidden"
              name="latitude"
              value={String(place.location.latitude)}
            />
            <input
              type="hidden"
              name="longitude"
              value={String(place.location.longitude)}
            />
            <button
              type="submit"
              class="btn btn-ghost btn-sm justify-start w-full"
            >
              {place.label}
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
