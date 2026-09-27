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
      'trip:',
      'trip:x',
      'trip:0',
      'trip:99999999999',
      'trip:12x',
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

  it('reads a trip, with a day and an occasion when given', () => {
    expect(parseDestination({ for: 'trip:12' })).toEqual({
      kind: 'trip',
      tripId: 12,
    });
    expect(
      parseDestination({ for: 'trip:12:2026-10-06', occasion: 'evening' }),
    ).toEqual({
      kind: 'trip',
      tripId: 12,
      day: '2026-10-06',
      occasion: 'evening',
    });
    // No occasion is not all day on a trip: the outfit is simply for the trip.
    expect(parseDestination({ for: 'trip:12', occasion: 'dinner' })).toEqual({
      kind: 'trip',
      tripId: 12,
    });
    // A malformed day is no day; the trip stays.
    expect(parseDestination({ for: 'trip:12:2026-02-30' })).toEqual({
      kind: 'trip',
      tripId: 12,
    });
  });

  it('writes a trip back as the query it was read from', () => {
    for (const destination of [
      { kind: 'trip', tripId: 7 },
      { kind: 'trip', tripId: 7, day: '2026-10-06' },
      { kind: 'trip', tripId: 7, occasion: 'workout' },
      { kind: 'trip', tripId: 7, day: '2026-10-06', occasion: 'night-out' },
    ] as const) {
      const params = new URLSearchParams(destinationQuery(destination));
      expect(
        parseDestination({
          for: params.get('for') ?? undefined,
          occasion: params.get('occasion') ?? undefined,
        }),
      ).toEqual(destination);
    }
    expect(
      destinationQuery({ kind: 'trip', tripId: 7, day: '2026-10-06' }),
    ).toBe('for=trip:7:2026-10-06');
  });
});
