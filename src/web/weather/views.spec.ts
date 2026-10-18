import { describe, expect, it } from 'vitest';
import type { TodayLine } from './summary';
import { weatherLineText } from './views';

// The morning push carries this text (src/web/push/reminders.ts); no page spec reads it.
const line = (over: Partial<TodayLine>): TodayLine => ({
  condition: 'clear',
  high: 18,
  low: 12,
  unit: 'celsius',
  rainFrom: null,
  rainNow: false,
  layer: false,
  place: null,
  fetchedAt: new Date('2026-09-26T13:05:00Z'),
  ...over,
});

describe('weatherLineText', () => {
  it('says when rain starts, and asks for a layer', () => {
    expect(weatherLineText(line({ rainFrom: 15, layer: true }))).toBe(
      '☀️ 12–18 °C · rain from 3 pm · take a layer',
    );
  });

  it('says rain now over a later start, and nothing without rain', () => {
    expect(weatherLineText(line({ rainNow: true, rainFrom: 15 }))).toBe(
      '☀️ 12–18 °C · rain now',
    );
    expect(weatherLineText(line({}))).toBe('☀️ 12–18 °C');
  });
});
