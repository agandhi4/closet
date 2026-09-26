import { describe, expect, it } from 'vitest';
import { stream } from './random';

describe('random streams', () => {
  const draws = (...key: (string | number)[]) => {
    const random = stream(...key);
    return Array.from({ length: 5 }, () => random.next());
  };

  it('are the same for the same key, and independent across keys', () => {
    expect(draws('demo', 'outfit', '2026-07-01')).toEqual(
      draws('demo', 'outfit', '2026-07-01'),
    );
    expect(draws('demo', 'outfit', '2026-07-01')).not.toEqual(
      draws('demo', 'weather', '2026-07-01'),
    );
  });

  it('draw in [0, 1) and pick by weight', () => {
    const random = stream('spec');
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i += 1) {
      const x = random.next();
      expect(x >= 0 && x < 1).toBe(true);
      counts[random.weighted([1, 0, 3])] += 1;
    }
    expect(counts[1]).toBe(0);
    expect(counts[2] / counts[0]).toBeGreaterThan(2.4);
    expect(stream('spec').weighted([0, 0])).toBe(-1);
  });
});
