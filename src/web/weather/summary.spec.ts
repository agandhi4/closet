import { describe, expect, it } from 'vitest';
import type { DayForecast } from '../../weather/forecast';
import { NO_WEATHER_SETTINGS, type WeatherSettings } from './queries';
import { dayChips, shortPlace, todayLine } from './summary';

function day(
  date: string,
  feels: (hour: number) => number,
  rainAt: readonly number[] = [],
): DayForecast {
  return {
    day: date,
    code: rainAt.length > 0 ? 63 : 2,
    high: 18.4,
    low: 9.6,
    precipitationChance: rainAt.length > 0 ? 80 : 10,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike: feels(hour),
      precipitationChance: rainAt.includes(hour) ? 80 : 10,
      code: rainAt.includes(hour) ? 63 : 2,
    })),
  };
}

const mild = (hour: number) => 16 + (hour >= 12 ? 1 : 0);
const swinging = (hour: number) => (hour < 12 ? 8 : 20);
const fetchedAt = new Date('2026-09-26T13:05:00Z');
const home = {
  location: { latitude: 40.69, longitude: -73.98 },
  source: 'home' as const,
  name: 'Fort Greene, New York, United States',
};
// Pinned to °C so these expectations don't depend on the default unit.
const settings: WeatherSettings = { ...NO_WEATHER_SETTINGS, unit: 'celsius' };

function line(
  forecastDay: DayForecast,
  hour: number,
  overrides: Partial<WeatherSettings> = {},
) {
  return todayLine({
    cached: {
      forecast: { timeZone: 'America/New_York', days: [forecastDay] },
      fetchedAt,
    },
    active: home,
    settings: { ...settings, ...overrides },
    today: forecastDay.day,
    hour,
  });
}

describe('the weather line', () => {
  it("summarises today in the user's unit", () => {
    expect(line(day('2026-09-26', mild), 9)).toEqual({
      condition: 'partly-cloudy',
      high: 18,
      low: 10,
      unit: 'celsius',
      rainFrom: null,
      rainNow: false,
      layer: false,
      place: 'Fort Greene',
      fetchedAt,
    });
    expect(
      line(day('2026-09-26', mild), 9, { unit: 'fahrenheit' }),
    ).toMatchObject({ high: 65, low: 49, unit: 'fahrenheit' });
  });

  it('says when rain starts, only if it is still to come', () => {
    const wet = day('2026-09-26', mild, [15, 16, 17]);
    expect(line(wet, 9)).toMatchObject({ rainFrom: 15, rainNow: false });
    expect(line(wet, 16)).toMatchObject({ rainFrom: null, rainNow: true });
    expect(line(wet, 18)).toMatchObject({ rainFrom: null, rainNow: false });
  });

  it("asks for a layer when the day's swing does", () => {
    expect(line(day('2026-09-26', swinging), 9)?.layer).toBe(true);
    expect(line(day('2026-09-26', mild), 9)?.layer).toBe(false);
  });

  it('has nothing to say for a day the forecast lacks', () => {
    expect(
      todayLine({
        cached: {
          forecast: {
            timeZone: 'America/New_York',
            days: [day('2026-09-25', mild)],
          },
          fetchedAt,
        },
        active: home,
        settings,
        today: '2026-09-26',
        hour: 9,
      }),
    ).toBeNull();
  });

  it('names the phone location by no place', () => {
    expect(
      todayLine({
        cached: {
          forecast: {
            timeZone: 'America/New_York',
            days: [day('2026-09-26', mild)],
          },
          fetchedAt,
        },
        active: { ...home, source: 'here', name: null },
        settings,
        today: '2026-09-26',
        hour: 9,
      })?.place,
    ).toBeNull();
    expect(shortPlace('Brooklyn, New York, United States')).toBe('Brooklyn');
  });
});

describe('the calendar chips', () => {
  it('covers the asked days the forecast has', () => {
    const cached = {
      forecast: {
        timeZone: 'America/New_York',
        days: [day('2026-09-26', mild), day('2026-09-27', mild, [8])],
      },
      fetchedAt,
    };
    expect(
      dayChips(cached, ['2026-09-25', '2026-09-26', '2026-09-27'], 'celsius'),
    ).toEqual([
      { day: '2026-09-26', condition: 'partly-cloudy', high: 18, low: 10 },
      { day: '2026-09-27', condition: 'rain', high: 18, low: 10 },
    ]);
  });
});
