import { describe, expect, it } from 'vitest';
import { destinationQuery, parseDestination } from './destination';

describe('OutfitDestination (?for=)', () => {
  it('reads a day with its occasion', () => {
    expect(
      parseDestination({ for: 'day:2026-09-29', occasion: 'evening' }),
    ).toEqual({ kind: 'day', day: '2026-09-29', occasion: 'evening' });
  });

  it('gives a day without an occasion, or with an unknown one, all day', () => {
    for (const occasion of [undefined, '', 'dinner', 'EVENING']) {
      expect(parseDestination({ for: 'day:2026-09-29', occasion })).toEqual({
        kind: 'day',
        day: '2026-09-29',
        occasion: 'all-day',
      });
    }
  });

  it('reads anything else as no destination, never an error', () => {
    for (const target of [
      undefined,
      '',
      'day:',
      'day:2026-02-30',
      'day:2026-09-29T00:00:00Z',
      '2026-09-29',
      'trip:12',
      'week:2026-09-27',
    ]) {
      expect(
        parseDestination({ for: target, occasion: 'evening' }),
        String(target),
      ).toEqual({ kind: 'none' });
    }
  });

  it('writes a day back as the query it was read from', () => {
    const query = destinationQuery({
      kind: 'day',
      day: '2026-09-29',
      occasion: 'night-out',
    });
    expect(query).toBe('for=day:2026-09-29&occasion=night-out');
    const params = new URLSearchParams(query);
    expect(
      parseDestination({
        for: params.get('for') ?? undefined,
        occasion: params.get('occasion') ?? undefined,
      }),
    ).toEqual({ kind: 'day', day: '2026-09-29', occasion: 'night-out' });
    expect(destinationQuery({ kind: 'none' })).toBe('');
  });
});
