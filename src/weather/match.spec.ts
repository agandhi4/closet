import { describe, expect, it } from 'vitest';
import type { Occasion } from '../wardrobe/occasions';
import type { GarmentRole, Warmth } from '../wardrobe/properties';
import type { DayForecast } from './forecast';
import {
  assessOutfit,
  limbTarget,
  type MatchGarment,
  matchGarment,
  torsoTarget,
  type WeatherNeeds,
  weatherNeeds,
} from './match';

/**
 * A day whose feels-like runs from `low` at 6:00 to `high` at 15:00 and back
 * (the shape of a clear day), with rain at `rainAt` hours.
 */
function day(
  low: number,
  high: number,
  rainAt: readonly number[] = [],
): DayForecast {
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const phase =
      hour >= 6 && hour <= 15
        ? (1 - Math.cos((Math.PI * (hour - 6)) / 9)) / 2
        : (1 + Math.cos((Math.PI * ((hour + 24 - 15) % 24)) / 15)) / 2;
    return {
      hour,
      feelsLike: low + (high - low) * phase,
      precipitationChance: rainAt.includes(hour) ? 80 : 10,
      code: rainAt.includes(hour) ? 63 : 1,
    };
  });
  return {
    day: '2026-09-26',
    code: rainAt.length > 0 ? 63 : 1,
    high,
    low,
    precipitationChance: rainAt.length > 0 ? 80 : 10,
    hours,
  };
}

function needs(
  forecast: DayForecast,
  occasion: Occasion,
  offset = 0,
): WeatherNeeds {
  const result = weatherNeeds(forecast, occasion, offset);
  if (!result) throw new Error('no hours in the window');
  return result;
}

const g = (
  role: GarmentRole,
  warmth: Warmth,
  waterResistant = false,
): MatchGarment => ({ role, warmth, waterResistant });

const TEE = g('top', 2);
const TANK = g('top', 1);
const SWEATER = g('top', 4);
const SHORTS = g('bottom', 1);
const CHINOS = g('bottom', 2);
const JEANS = g('bottom', 3);
const SNEAKERS = g('footwear', 2);
const SANDALS = g('footwear', 1);
const BOOTS = g('footwear', 4);
const JACKET = g('layer', 3);
const RAIN_JACKET = g('layer', 2, true);
const PARKA = g('layer', 5, true);
const DRESS = g('one-piece', 2);

// New York feels-like days (°C), low at 6:00, high at 15:00.
const JULY = day(25, 33);
const APRIL = day(8, 18);
const OCTOBER_RAIN = day(9, 17, [16, 17, 18, 19]);
const JANUARY = day(-6, 0);

describe('weather matching', () => {
  describe('targets', () => {
    it('steps the torso every 4 °C from a tank in the heat to a parka in the cold', () => {
      expect([34, 28, 24, 18, 14, 10, 2, -2, -6, -10].map(torsoTarget)).toEqual(
        [1, 1, 2, 3, 4, 5, 7, 8, 9, 9],
      );
    });

    it('steps legs and feet from shorts and sandals to the warmest', () => {
      expect([30, 26, 19, 12, 5, -5].map(limbTarget)).toEqual([
        1, 1, 2, 3, 4, 5,
      ]);
    });
  });

  describe('the occasion window', () => {
    it("reads only the occasion's hours", () => {
      const work = needs(APRIL, 'work');
      expect(work.window).toEqual({ from: 8, to: 18 });
      const evening = needs(APRIL, 'evening');
      expect(evening.window).toEqual({ from: 18, to: 23 });
      // The afternoon peak is in the work window, not the evening's.
      expect(work.feelsLike.max).toBeCloseTo(18);
      expect(evening.feelsLike.max).toBeLessThan(18);
      expect(evening.feelsLike.min).toBeGreaterThan(8);
    });

    it('is null for a day without those hours', () => {
      const late = { ...APRIL, hours: APRIL.hours.filter((h) => h.hour < 8) };
      expect(weatherNeeds(late, 'work', 0)).toBeNull();
      expect(weatherNeeds(late, 'workout', 0)).not.toBeNull();
    });
  });

  describe('summer (July, 25 to 33 °C)', () => {
    it('asks for a tee and shorts, and no layer for a swing inside the heat', () => {
      const allDay = needs(JULY, 'all-day');
      expect(allDay.layer).toBe(false);
      expect(allDay.torso).toBeLessThanOrEqual(2);
      expect(allDay.limbs).toBe(1);
      expect(assessOutfit(allDay, [TEE, SHORTS, SANDALS]).fits).toBe(true);
      expect(assessOutfit(allDay, [TANK, CHINOS, SNEAKERS]).fits).toBe(true);
    });

    it('calls a sweater or a parka too warm', () => {
      const allDay = needs(JULY, 'all-day');
      expect(assessOutfit(allDay, [SWEATER, SHORTS]).problems).toEqual([
        'too-warm',
      ]);
      expect(assessOutfit(allDay, [TEE, PARKA, SHORTS]).problems).toContain(
        'too-warm',
      );
      expect(assessOutfit(allDay, [TEE, SHORTS, BOOTS]).problems).toEqual([
        'feet-too-warm',
      ]);
    });

    it('takes jeans in the heat, which people wear', () => {
      expect(assessOutfit(needs(JULY, 'work'), [TEE, JEANS]).fits).toBe(true);
    });

    it('dresses a morning workout for the morning', () => {
      const workout = needs(JULY, 'workout');
      expect(workout.window).toEqual({ from: 6, to: 9 });
      expect(workout.feelsLike.max).toBeLessThan(28);
      expect(assessOutfit(workout, [TEE, SHORTS, SNEAKERS]).fits).toBe(true);
    });
  });

  describe('spring (April, 8 to 18 °C)', () => {
    it('asks for a layer that comes off across the working day', () => {
      const work = needs(APRIL, 'work');
      expect(work.layer).toBe(true);
      expect(work.torso).toBeGreaterThan(work.torsoWithoutLayer);
      const layered = assessOutfit(work, [TEE, JACKET, JEANS, SNEAKERS]);
      expect(layered).toMatchObject({ fits: true, score: 0 });
      expect(layered.torso).toEqual({ withLayer: 5, withoutLayer: 2 });
    });

    it('flags an outfit without the layer', () => {
      const work = needs(APRIL, 'work');
      const tee = assessOutfit(work, [TEE, JEANS]);
      const sweater = assessOutfit(work, [SWEATER, JEANS]);
      expect(tee.problems).toEqual(['too-cold', 'needs-layer']);
      // Warm enough on the walk in, but nothing to take off at 3 pm.
      expect(sweater.problems).toEqual(['needs-layer']);
      expect(sweater.score).toBeLessThan(tee.score);
    });

    it('calls shorts too cold, and a dress fine under a jacket', () => {
      const work = needs(APRIL, 'work');
      expect(assessOutfit(work, [TEE, JACKET, SHORTS]).problems).toEqual([
        'legs-too-cold',
      ]);
      expect(assessOutfit(work, [DRESS, JACKET, SNEAKERS]).problems).toEqual(
        [],
      );
    });

    it('dresses an evening out for the evening: no swing, a jacket', () => {
      const evening = needs(APRIL, 'evening');
      expect(evening.layer).toBe(false);
      expect(assessOutfit(evening, [TEE, JACKET, JEANS]).fits).toBe(true);
      expect(assessOutfit(evening, [TEE, CHINOS]).problems).toEqual([
        'too-cold',
      ]);
    });
  });

  describe('autumn rain (October, 9 to 17 °C, rain from 16:00)', () => {
    it('asks for water resistance when the rain falls inside the window', () => {
      const work = needs(OCTOBER_RAIN, 'work');
      expect(work.rain).toBe(true);
      expect(
        assessOutfit(work, [TEE, JACKET, JEANS, SNEAKERS]).problems,
      ).toEqual(['needs-water-resistance']);
      expect(
        assessOutfit(work, [SWEATER, RAIN_JACKET, JEANS, SNEAKERS]).fits,
      ).toBe(true);
      // Water-resistant boots do it as well as a rain jacket.
      expect(
        assessOutfit(work, [TEE, JACKET, JEANS, g('footwear', 3, true)]).fits,
      ).toBe(true);
    });

    it('does not ask for it when the rain is outside the window', () => {
      expect(needs(OCTOBER_RAIN, 'workout').rain).toBe(false);
    });

    it('does not count a water-resistant bag', () => {
      const work = needs(OCTOBER_RAIN, 'work');
      expect(assessOutfit(work, [SWEATER, RAIN_JACKET, JEANS]).fits).toBe(true);
      expect(
        assessOutfit(work, [TEE, JACKET, JEANS, g('bag', 1, true)]).problems,
      ).toEqual(['needs-water-resistance']);
    });
  });

  describe('winter (January, -6 to 0 °C)', () => {
    it('asks for a sweater under a coat or a parka, and calls a jacket too cold', () => {
      const allDay = needs(JANUARY, 'all-day');
      expect(allDay.torso).toBe(8);
      expect(allDay.limbs).toBe(5);
      expect(
        assessOutfit(allDay, [SWEATER, PARKA, g('bottom', 4), BOOTS]).fits,
      ).toBe(true);
      const light = assessOutfit(allDay, [TEE, JACKET, JEANS, SNEAKERS]);
      expect(light.problems).toEqual([
        'too-cold',
        'legs-too-cold',
        'feet-too-cold',
      ]);
      expect(light.score).toBeGreaterThan(0);
    });
  });

  describe('the personal offset', () => {
    const mild = day(18, 22);

    it('dresses someone who runs cold warmer, and someone who runs warm lighter', () => {
      const outfit = [TEE, CHINOS, SNEAKERS];
      expect(assessOutfit(needs(mild, 'daytime'), outfit).fits).toBe(true);
      expect(needs(mild, 'daytime', -5).torso).toBeGreaterThan(
        needs(mild, 'daytime').torso,
      );
      expect(assessOutfit(needs(mild, 'daytime', -5), outfit).problems).toEqual(
        ['too-cold'],
      );
      expect(needs(mild, 'daytime', 5).torso).toBeLessThan(
        needs(mild, 'daytime').torso,
      );
      expect(assessOutfit(needs(mild, 'daytime', 5), outfit).fits).toBe(true);
    });

    it('shifts the feels-like range it reports', () => {
      const plain = needs(mild, 'daytime');
      const cold = needs(mild, 'daytime', -2);
      expect(cold.feelsLike.min).toBeCloseTo(plain.feelsLike.min - 2);
      expect(cold.feelsLike.max).toBeCloseTo(plain.feelsLike.max - 2);
    });
  });

  it('ranks a closer miss above a further one', () => {
    const work = needs(APRIL, 'work');
    const near = assessOutfit(work, [SWEATER, JEANS]);
    const far = assessOutfit(work, [TANK, SHORTS]);
    expect(near.score).toBeLessThan(far.score);
  });

  it('judges only the parts an outfit has', () => {
    const work = needs(APRIL, 'work');
    // A layer without a top leaves the torso unjudged: the generator
    // fills the top next.
    expect(assessOutfit(work, [JACKET]).problems).toEqual([]);
    expect(assessOutfit(work, [JEANS]).problems).toEqual(['needs-layer']);
    expect(assessOutfit(work, []).problems).toEqual(['needs-layer']);
  });

  describe('matchGarment', () => {
    const fields = {
      category: 'tops',
      type: 't-shirt',
      fabricWeight: null,
      warmth: null,
      waterResistant: false,
    };

    it("counts a garment's own warmth first", () => {
      expect(matchGarment({ ...fields, warmth: 4 })).toEqual({
        role: 'top',
        warmth: 4,
        waterResistant: false,
      });
    });

    it("falls back to the type's preset, weight step included", () => {
      expect(matchGarment(fields).warmth).toBe(2);
      expect(matchGarment({ ...fields, fabricWeight: 220 }).warmth).toBe(3);
      expect(
        matchGarment({
          category: 'outerwear',
          type: 'parka',
          fabricWeight: null,
          warmth: null,
          waterResistant: true,
        }),
      ).toEqual({ role: 'layer', warmth: 5, waterResistant: true });
    });

    it("falls back to the role's usual warmth without a type", () => {
      expect(matchGarment({ ...fields, type: null }).warmth).toBe(2);
      expect(
        matchGarment({ ...fields, category: 'outerwear', type: null }).warmth,
      ).toBe(3);
      expect(
        matchGarment({ ...fields, category: 'hats I knit', type: null }),
      ).toMatchObject({ role: 'none', warmth: 1 });
    });
  });
});
