import { describe, expect, it } from 'vitest';
import {
  noiseBetween,
  percentile,
  relativeChange,
  summarizeCount,
  summarizeTiming,
} from './stats';

describe('percentile', () => {
  it('interpolates between the closest ranks', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
  });

  it('is the value itself for one run, and the ends at 0 and 100', () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });

  it('does not reorder the caller’s array', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it('refuses no values and a percentile outside 0..100', () => {
    expect(() => percentile([], 50)).toThrow('no values');
    expect(() => percentile([1], 101)).toThrow('outside');
  });
});

describe('summaries', () => {
  it('times: n, min, p50, p95 and max', () => {
    const runs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(summarizeTiming(runs)).toEqual({
      n: 20,
      min: 1,
      p50: 10.5,
      p95: 19.05,
      max: 20,
    });
  });

  it('counts: the median and the range, which says a count varied', () => {
    expect(summarizeCount([8, 8, 8])).toEqual({ median: 8, min: 8, max: 8 });
    expect(summarizeCount([8, 9, 8])).toEqual({ median: 8, min: 8, max: 9 });
  });
});

describe('relativeChange', () => {
  it('is signed, as a fraction of the baseline', () => {
    expect(relativeChange(10, 12)).toBeCloseTo(0.2);
    expect(relativeChange(10, 5)).toBe(-0.5);
  });

  it('is 0 from nothing to nothing and infinite from nothing to something', () => {
    expect(relativeChange(0, 0)).toBe(0);
    expect(relativeChange(0, 1)).toBe(Infinity);
  });
});

describe('noiseBetween', () => {
  it('is the median and 90th percentile of the absolute p50 changes', () => {
    const noise = noiseBetween([
      { before: 10, after: 11 },
      { before: 10, after: 9 },
      { before: 20, after: 20 },
      { before: 5, after: 6 },
    ]);
    expect(noise.steps).toBe(4);
    expect(noise.median).toBeCloseTo(0.1);
    expect(noise.p90).toBeCloseTo(0.17);
  });

  it('leaves out a step whose baseline was 0 ms', () => {
    expect(noiseBetween([{ before: 0, after: 3 }])).toEqual({
      median: 0,
      p90: 0,
      steps: 0,
    });
  });
});
