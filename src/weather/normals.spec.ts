import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../calendar-date';
import { diurnalPhase, RAIN_CHANCE } from './forecast';
import { assessOutfit, type MatchGarment, weatherNeeds } from './match';
import {
  climateNormals,
  type DayNormals,
  monthDayOf,
  NORMAL_WINDOW_DAYS,
  normalsOn,
  normalYears,
  type ObservedDay,
  typicalDay,
  WET_DAY_MM,
} from './normals';

const YEARS = { first: 2016, last: 2025 };

/** Every day of YEARS, observed as `shape` says. */
function observed(
  shape: (day: IsoDate) => Partial<Omit<ObservedDay, 'day'>> = () => ({}),
): ObservedDay[] {
  const days: ObservedDay[] = [];
  for (let day = '2016-01-01'; day <= '2025-12-31'; day = addDays(day, 1)) {
    days.push({
      day,
      high: 20,
      low: 10,
      feelsHigh: 19,
      feelsLow: 8,
      precipitation: 0,
      ...shape(day),
    });
  }
  return days;
}

describe('climate normals', () => {
  it('average the ten whole years before this one, fixed all year', () => {
    expect(normalYears('2026-09-27')).toEqual({ first: 2016, last: 2025 });
    expect(normalYears('2026-01-01')).toEqual({ first: 2016, last: 2025 });
    expect(normalYears('2027-01-01')).toEqual({ first: 2017, last: 2026 });
  });

  it('are the mean of each calendar day and the days around it, every year', () => {
    const normals = climateNormals(observed(), YEARS);
    expect(normals.years).toEqual(YEARS);
    expect(Object.keys(normals.days)).toHaveLength(366);
    expect(normalsOn(normals, '2031-07-04')).toEqual({
      high: 20,
      low: 10,
      feelsHigh: 19,
      feelsLow: 8,
      rainChance: 0,
    });
  });

  it(`count ${NORMAL_WINDOW_DAYS} days either side, across New Year`, () => {
    // 1 January is 34 °C every year and every other day 20 °C: its window
    // holds 15 days a year, one of them hot.
    const normals = climateNormals(
      observed((day) => (monthDayOf(day) === '01-01' ? { high: 34 } : {})),
      YEARS,
    );
    const hot = (20 * 14 + 34) / 15;
    expect(normals.days['01-01'].high).toBeCloseTo(hot, 1);
    expect(normals.days['01-08'].high).toBeCloseTo(hot, 1);
    expect(normals.days['01-09'].high).toBe(20);
    // December's last week reaches over New Year.
    expect(normals.days['12-25'].high).toBeCloseTo(hot, 1);
    expect(normals.days['12-24'].high).toBe(20);
  });

  it(`say how often a day was wet (${WET_DAY_MM} mm or more)`, () => {
    // Wet in the first half of the years, and 0.9 mm (dry) in the rest.
    const normals = climateNormals(
      observed((day) => ({
        precipitation: day < '2021-01-01' ? WET_DAY_MM : 0.9,
      })),
      YEARS,
    );
    expect(normals.days['06-15'].rainChance).toBe(50);
  });

  it('keep 29 February, and leave out a day nothing was observed near', () => {
    const normals = climateNormals(
      observed().filter((day) => monthDayOf(day.day) < '09-01'),
      YEARS,
    );
    expect(normalsOn(normals, '2028-02-29')?.high).toBe(20);
    expect(normalsOn(normals, '2026-09-07')).toBeDefined();
    expect(normalsOn(normals, '2026-09-08')).toBeUndefined();
  });
});

describe('a typical day', () => {
  const COOL: DayNormals = {
    high: 16,
    low: 8,
    feelsHigh: 15,
    feelsLow: 5,
    rainChance: 30,
  };

  it('is a forecast day whose feels-like runs from the normal low at dawn to the high mid-afternoon', () => {
    const day = typicalDay('2026-11-02', COOL);
    expect(day).toMatchObject({
      day: '2026-11-02',
      high: 16,
      low: 8,
      precipitationChance: 30,
    });
    expect(day.hours.map((h) => h.hour)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    expect(day.hours[6].feelsLike).toBe(5);
    expect(day.hours[15].feelsLike).toBe(15);
    expect(day.hours[10].feelsLike).toBeCloseTo(5 + 10 * diurnalPhase(10), 1);
    expect(new Set(day.hours.map((h) => h.precipitationChance))).toEqual(
      new Set([30]),
    );
  });

  it('asks what a forecast day with those hours asks, a layer for a wide swing included', () => {
    const needs = weatherNeeds(typicalDay('2026-11-02', COOL), 'all-day', 0)!;
    expect(needs.layer).toBe(true);
    expect(needs.rain).toBe(false);
    expect(needs.feelsLike.max).toBe(15);
    const tee: MatchGarment = { role: 'top', warmth: 2, waterResistant: false };
    const jacket: MatchGarment = {
      role: 'layer',
      warmth: 3,
      waterResistant: false,
    };
    const jeans: MatchGarment = {
      role: 'bottom',
      warmth: 3,
      waterResistant: false,
    };
    expect(assessOutfit(needs, [tee, jacket, jeans]).fits).toBe(true);
    expect(assessOutfit(needs, [tee, jeans]).problems).toContain('needs-layer');
  });

  it(`asks for water resistance only where most days are wet (${RAIN_CHANCE} %)`, () => {
    const wet = typicalDay('2026-07-15', { ...COOL, rainChance: RAIN_CHANCE });
    expect(weatherNeeds(wet, 'all-day', 0)!.rain).toBe(true);
    expect(wet.code).toBe(63);
    const snowy = typicalDay('2027-01-15', {
      high: -2,
      low: -9,
      feelsHigh: -6,
      feelsLow: -14,
      rainChance: 60,
    });
    expect(snowy.code).toBe(73);
    expect(typicalDay('2026-11-02', COOL).code).toBe(2);
  });

  it("takes the person's offset like a forecast day", () => {
    const day = typicalDay('2026-11-02', COOL);
    expect(weatherNeeds(day, 'all-day', 2)!.feelsLike.max).toBe(17);
  });
});
