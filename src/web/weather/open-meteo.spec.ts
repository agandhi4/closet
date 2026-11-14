import { describe, expect, it } from 'vitest';
import type { FetchRequest, OutboundFetcher } from '../security/outbound-fetch';
import {
  createOpenMeteoClient,
  OPEN_METEO,
  WeatherResponseError,
} from './open-meteo';

/** A fetcher that answers `body` and records what it was asked. */
function fetcherAnswering(body: unknown) {
  const calls: { url: string; request: FetchRequest }[] = [];
  const fetcher: OutboundFetcher = {
    fetch(url, request) {
      calls.push({ url, request });
      return Promise.resolve({
        kind: 'json',
        mediaType: 'application/json',
        charset: null,
        body: Buffer.from(
          typeof body === 'string' ? body : JSON.stringify(body),
        ),
        truncated: false,
        url: new URL(url),
        redirects: 0,
      });
    },
  };
  return { fetcher, calls };
}

const NEW_YORK = {
  latitude: 40.69,
  longitude: -74,
  timeZone: 'America/New_York',
};
const AUSTIN = {
  latitude: 30.27,
  longitude: -97.74,
  timeZone: 'America/Chicago',
};

const ANSWER = {
  latitude: 40.6875,
  longitude: -73.97,
  timezone: 'America/New_York',
  hourly: {
    time: ['2026-09-26T00:00', '2026-09-26T01:00', '2026-09-27T00:00'],
    apparent_temperature: [14.2, null, 12],
    precipitation_probability: [null, 40, 90],
    weather_code: [2, 3, null],
  },
  daily: {
    time: ['2026-09-26', '2026-09-27', '2026-09-28'],
    weather_code: [3, 63, 0],
    temperature_2m_max: [19.1, 16, null],
    temperature_2m_min: [11.4, 10.2, 9],
    precipitation_probability_max: [40, 90, 5],
  },
};

describe('the Open-Meteo client', () => {
  it("asks the fixed host for the rounded location, in the place's zone", async () => {
    const { fetcher, calls } = fetcherAnswering(ANSWER);
    const client = createOpenMeteoClient({ fetcher });
    await client.forecast(NEW_YORK);
    const [{ url, request }] = calls;
    const sent = new URL(url);
    expect(`${sent.origin}${sent.pathname}`).toBe(OPEN_METEO.forecast);
    expect(sent.searchParams.get('latitude')).toBe('40.69');
    expect(sent.searchParams.get('longitude')).toBe('-74.00');
    expect(sent.searchParams.get('timezone')).toBe('America/New_York');
    expect(request).toEqual({
      accept: ['json'],
      hosts: ['api.open-meteo.com'],
    });
  });

  it('normalizes the answer, leaving out what is missing', async () => {
    const client = createOpenMeteoClient({
      fetcher: fetcherAnswering(ANSWER).fetcher,
    });
    expect(await client.forecast(NEW_YORK)).toEqual({
      timeZone: 'America/New_York',
      days: [
        {
          day: '2026-09-26',
          code: 3,
          high: 19.1,
          low: 11.4,
          precipitationChance: 40,
          hours: [
            { hour: 0, feelsLike: 14.2, precipitationChance: 0, code: 2 },
          ],
        },
        {
          day: '2026-09-27',
          code: 63,
          high: 16,
          low: 10.2,
          precipitationChance: 90,
          hours: [{ hour: 0, feelsLike: 12, precipitationChance: 90, code: 3 }],
        },
      ],
    });
  });

  it("asks a destination's forecast in its own zone, and refuses another zone's answer (#678)", async () => {
    const tokyo = {
      latitude: 35.68,
      longitude: 139.69,
      timeZone: 'Asia/Tokyo',
    };
    const { fetcher, calls } = fetcherAnswering({
      ...ANSWER,
      timezone: 'Asia/Tokyo',
    });
    const forecast = await createOpenMeteoClient({ fetcher }).forecast(tokyo);
    expect(new URL(calls[0].url).searchParams.get('timezone')).toBe(
      'Asia/Tokyo',
    );
    expect(forecast.timeZone).toBe('Asia/Tokyo');
    // The echo goes through the requested zone's canonicaliser: GMT is UTC.
    const utc = createOpenMeteoClient({
      fetcher: fetcherAnswering({ ...ANSWER, timezone: 'GMT' }).fetcher,
    });
    await expect(
      utc.forecast({ ...tokyo, timeZone: 'UTC' }),
    ).resolves.toMatchObject({ timeZone: 'UTC' });
    const elsewhere = createOpenMeteoClient({
      fetcher: fetcherAnswering(ANSWER).fetcher,
    });
    await expect(elsewhere.forecast(tokyo)).rejects.toBeInstanceOf(
      WeatherResponseError,
    );
  });

  it('refuses an answer that is not the documented shape', async () => {
    for (const body of [
      'not json',
      { hourly: {} },
      {
        ...ANSWER,
        hourly: { ...ANSWER.hourly, apparent_temperature: [1] },
      },
    ]) {
      const client = createOpenMeteoClient({
        fetcher: fetcherAnswering(body).fetcher,
      });
      await expect(client.forecast(NEW_YORK)).rejects.toBeInstanceOf(
        WeatherResponseError,
      );
    }
  });

  it('turns search results into rounded places with a readable label', async () => {
    const { fetcher, calls } = fetcherAnswering({
      results: [
        {
          name: 'New York',
          latitude: 40.71427,
          longitude: -74.00597,
          admin1: 'New York',
          country: 'United States',
          timezone: 'America/New_York',
        },
        // The zone canonicalised; one Intl does not know, or an offset, is none.
        {
          name: 'Tokyo',
          latitude: 35.6895,
          longitude: 139.69171,
          country: 'Japan',
          timezone: 'asia/tokyo',
        },
        { name: 'Elsewhere', latitude: 1, longitude: 1, timezone: '+09:00' },
        { name: 'Nowhere', latitude: 95, longitude: 0 },
      ],
    });
    const client = createOpenMeteoClient({ fetcher });
    expect(await client.searchPlaces('new york')).toEqual([
      {
        label: 'New York, United States',
        location: { latitude: 40.71, longitude: -74.01 },
        timeZone: 'America/New_York',
      },
      {
        label: 'Tokyo, Japan',
        location: { latitude: 35.69, longitude: 139.69 },
        timeZone: 'Asia/Tokyo',
      },
      {
        label: 'Elsewhere',
        location: { latitude: 1, longitude: 1 },
        timeZone: null,
      },
    ]);
    expect(calls[0].request.hosts).toEqual(['geocoding-api.open-meteo.com']);
    expect(new URL(calls[0].url).searchParams.get('name')).toBe('new york');
  });

  it('answers no places when nothing matched', async () => {
    const client = createOpenMeteoClient({
      fetcher: fetcherAnswering({ generationtime_ms: 0.4 }).fetcher,
    });
    expect(await client.searchPlaces('atlantis')).toEqual([]);
  });

  describe('climate normals (the historical archive)', () => {
    const YEARS = { first: 2016, last: 2025 };
    // Two complete days in the requested years, one without a high, and a
    // day from outside them.
    const ARCHIVE = {
      latitude: 30.27,
      longitude: -97.74,
      timezone: 'America/Chicago',
      daily: {
        time: ['2015-12-31', '2016-07-01', '2016-07-02', '2016-07-03'],
        temperature_2m_max: [10, 35, 33, null],
        temperature_2m_min: [2, 24, 22, 23],
        apparent_temperature_max: [8, 38, 36, 37],
        apparent_temperature_min: [0, 25, 23, 24],
        precipitation_sum: [0, 0, 4.2, 0],
      },
    };

    it("asks the fixed archive host for whole years at the rounded location, in the place's zone", async () => {
      const { fetcher, calls } = fetcherAnswering(ARCHIVE);
      const client = createOpenMeteoClient({ fetcher });
      await client.normals(
        { latitude: 30.27, longitude: -97.7, timeZone: 'America/Chicago' },
        YEARS,
      );
      const [{ url, request }] = calls;
      const sent = new URL(url);
      expect(`${sent.origin}${sent.pathname}`).toBe(OPEN_METEO.archive);
      expect(Object.fromEntries(sent.searchParams)).toEqual({
        latitude: '30.27',
        longitude: '-97.70',
        start_date: '2016-01-01',
        end_date: '2025-12-31',
        daily:
          'temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum',
        timezone: 'America/Chicago',
      });
      expect(request).toEqual({
        accept: ['json'],
        hosts: ['archive-api.open-meteo.com'],
      });
    });

    it('averages the complete days of those years', async () => {
      const client = createOpenMeteoClient({
        fetcher: fetcherAnswering(ARCHIVE).fetcher,
      });
      const normals = await client.normals(AUSTIN, YEARS);
      expect(normals.years).toEqual(YEARS);
      // 1 and 2 July only: 3 July has no high, 31 December 2015 is outside.
      expect(normals.days['07-02']).toEqual({
        high: 34,
        low: 23,
        feelsHigh: 37,
        feelsLow: 24,
        rainChance: 50,
      });
      expect(normals.days['12-31']).toBeUndefined();
    });

    it('refuses an answer that is not the documented shape, or has no complete day', async () => {
      for (const body of [
        'not json',
        { daily: {} },
        { daily: { ...ARCHIVE.daily, precipitation_sum: [0] } },
        {
          daily: {
            time: ['2016-07-03'],
            temperature_2m_max: [null],
            temperature_2m_min: [1],
            apparent_temperature_max: [1],
            apparent_temperature_min: [1],
            precipitation_sum: [1],
          },
        },
      ]) {
        const client = createOpenMeteoClient({
          fetcher: fetcherAnswering(body).fetcher,
        });
        await expect(client.normals(AUSTIN, YEARS)).rejects.toBeInstanceOf(
          WeatherResponseError,
        );
      }
    });
  });
});
