import { describe, expect, it } from 'vitest';
import { locationLabel, roundCoordinate, roundedLocation } from './location';
import {
  clampOffset,
  displayDifference,
  displayTemperature,
  nudgeOffset,
  OFFSET_LIMIT,
} from './temperature';

describe('weather location', () => {
  it('rounds to two decimals, about a kilometre', () => {
    // Fort Greene Park.
    expect(roundedLocation(40.689167, -73.975556)).toEqual({
      latitude: 40.69,
      longitude: -73.98,
    });
    expect(roundCoordinate(-0.004)).toBe(0);
    expect(Object.is(roundCoordinate(-0.004), -0)).toBe(false);
    expect(roundCoordinate(12.3456)).toBe(12.35);
    expect(roundCoordinate(-12.3456)).toBe(-12.35);
  });

  it('refuses what is not on the globe', () => {
    expect(roundedLocation(91, 0)).toBeNull();
    expect(roundedLocation(0, -180.5)).toBeNull();
    expect(roundedLocation(Number.NaN, 0)).toBeNull();
    expect(roundedLocation(-90, 180)).toEqual({
      latitude: -90,
      longitude: 180,
    });
  });

  it('names a location by its rounded coordinates only', () => {
    expect(locationLabel({ latitude: 40.7, longitude: -74 })).toBe(
      '40.70,-74.00',
    );
  });
});

describe('temperatures', () => {
  it('shows °C or °F in whole degrees', () => {
    expect(displayTemperature(21.6, 'celsius')).toBe(22);
    expect(displayTemperature(21.6, 'fahrenheit')).toBe(71);
    expect(displayTemperature(-0.2, 'celsius')).toBe(0);
    expect(displayTemperature(-17.8, 'fahrenheit')).toBe(0);
  });

  it('shows the offset as a difference, not a temperature', () => {
    expect(displayDifference(1.5, 'celsius')).toBe(1.5);
    expect(displayDifference(1.5, 'fahrenheit')).toBe(2.7);
    expect(displayDifference(-5, 'fahrenheit')).toBe(-9);
  });

  it('nudges the offset half a degree per feedback, within ±5', () => {
    expect(nudgeOffset(0, 'too-warm')).toBe(0.5);
    expect(nudgeOffset(0, 'too-cold')).toBe(-0.5);
    expect(nudgeOffset(-0.5, 'too-warm')).toBe(0);
    expect(nudgeOffset(OFFSET_LIMIT, 'too-warm')).toBe(OFFSET_LIMIT);
    expect(nudgeOffset(-OFFSET_LIMIT, 'too-cold')).toBe(-OFFSET_LIMIT);
    expect(clampOffset(7.3)).toBe(OFFSET_LIMIT);
    expect(clampOffset(1.26)).toBe(1.5);
  });
});
