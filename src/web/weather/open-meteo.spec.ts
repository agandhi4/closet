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
});
