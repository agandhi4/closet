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
        url: new URL(url),
        redirects: 0,
      });
    },
  };
  return { fetcher, calls };
}

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
  it('asks the fixed host for the rounded location, in the household zone', async () => {
    const { fetcher, calls } = fetcherAnswering(ANSWER);
    const client = createOpenMeteoClient({
      fetcher,
      timeZone: 'America/New_York',
    });
    await client.forecast({ latitude: 40.69, longitude: -74 });
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
      timeZone: 'America/New_York',
    });
    expect(await client.forecast({ latitude: 40.69, longitude: -74 })).toEqual({
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
        timeZone: 'America/New_York',
      });
      await expect(
        client.forecast({ latitude: 40.69, longitude: -74 }),
      ).rejects.toBeInstanceOf(WeatherResponseError);
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
        },
        { name: 'Nowhere', latitude: 95, longitude: 0 },
      ],
    });
    const client = createOpenMeteoClient({
      fetcher,
      timeZone: 'America/New_York',
    });
    expect(await client.searchPlaces('new york')).toEqual([
      {
        label: 'New York, United States',
        location: { latitude: 40.71, longitude: -74.01 },
      },
    ]);
    expect(calls[0].request.hosts).toEqual(['geocoding-api.open-meteo.com']);
    expect(new URL(calls[0].url).searchParams.get('name')).toBe('new york');
  });

  it('answers no places when nothing matched', async () => {
    const client = createOpenMeteoClient({
      fetcher: fetcherAnswering({ generationtime_ms: 0.4 }).fetcher,
      timeZone: 'America/New_York',
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
      daily: {
        time: ['2015-12-31', '2016-07-01', '2016-07-02', '2016-07-03'],
        temperature_2m_max: [10, 35, 33, null],
        temperature_2m_min: [2, 24, 22, 23],
        apparent_temperature_max: [8, 38, 36, 37],
        apparent_temperature_min: [0, 25, 23, 24],
        precipitation_sum: [0, 0, 4.2, 0],
      },
    };

    it('asks the fixed archive host for whole years at the rounded location, in the household zone', async () => {
      const { fetcher, calls } = fetcherAnswering(ARCHIVE);
      const client = createOpenMeteoClient({
        fetcher,
        timeZone: 'America/New_York',
      });
      await client.normals({ latitude: 30.27, longitude: -97.7 }, YEARS);
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
        timezone: 'America/New_York',
      });
      expect(request).toEqual({
        accept: ['json'],
        hosts: ['archive-api.open-meteo.com'],
      });
    });

    it('averages the complete days of those years', async () => {
      const client = createOpenMeteoClient({
        fetcher: fetcherAnswering(ARCHIVE).fetcher,
        timeZone: 'America/New_York',
      });
      const normals = await client.normals(
        { latitude: 30.27, longitude: -97.74 },
        YEARS,
      );
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
          timeZone: 'America/New_York',
        });
        await expect(
          client.normals({ latitude: 30.27, longitude: -97.74 }, YEARS),
        ).rejects.toBeInstanceOf(WeatherResponseError);
      }
    });
  });
});
