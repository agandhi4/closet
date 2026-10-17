import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { renderToString } from '../render';
import { destinationPickLabel } from './destination-views';
import {
  DestinationBody,
  DestinationFields,
  destinationQuery,
  type OutfitDestination,
  parseDestination,
} from './destination';

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

  it('carries the entry a pick replaces (#69), from a URL or a parsed body', () => {
    for (const replace of ['42', 42]) {
      expect(
        parseDestination({ for: 'day:2026-09-29', occasion: 'work', replace }),
      ).toEqual({
        kind: 'day',
        day: '2026-09-29',
        occasion: 'work',
        replace: 42,
      });
    }
    const query = destinationQuery({
      kind: 'day',
      day: '2026-09-29',
      occasion: 'work',
      replace: 42,
    });
    expect(query).toBe('for=day:2026-09-29&occasion=work&replace=42');
  });

  it('drops a malformed replace, and never reads one without a day', () => {
    for (const replace of ['', '0', '-1', '4.2', 'abc', '2147483648', '1e3']) {
      expect(
        parseDestination({ for: 'day:2026-09-29', replace }),
        replace,
      ).toEqual({ kind: 'day', day: '2026-09-29', occasion: 'all-day' });
    }
    expect(parseDestination({ replace: '42' })).toEqual({ kind: 'none' });
    // A trip outfit replaces nothing on the calendar.
    expect(parseDestination({ for: 'trip:12', replace: '42' })).toEqual({
      kind: 'trip',
      tripId: 12,
    });
  });
});

/** What a form posts: each hidden field's name and value. */
function postedFields(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

describe('DestinationFields (a write posts the destination back)', () => {
  const destinations: Exclude<OutfitDestination, { kind: 'none' }>[] = [
    { kind: 'day', day: '2026-09-29', occasion: 'all-day' },
    { kind: 'day', day: '2026-09-29', occasion: 'work', replace: 42 },
    { kind: 'trip', tripId: 12 },
    { kind: 'trip', tripId: 12, day: '2026-10-02', occasion: 'evening' },
  ];

  it('writes what DestinationBody accepts and parseDestination reads back', async () => {
    const Body = Type.Object(DestinationBody);
    for (const destination of destinations) {
      const posted = postedFields(
        await renderToString(<DestinationFields destination={destination} />),
      );
      // RowId coerces the string a form posts, as the route's schema does.
      const body = Value.Convert(Body, posted);
      expect(Value.Check(Body, body), JSON.stringify(posted)).toBe(true);
      expect(parseDestination(body as never)).toEqual(destination);
    }
  });

  it('writes nothing for no destination', async () => {
    expect(
      await renderToString(
        <DestinationFields destination={{ kind: 'none' }} />,
      ),
    ).toBe('');
  });

  it('names the pick by where it goes', () => {
    expect(destinationPickLabel({ kind: 'trip', tripId: 12 })).toBe(
      destinationPickLabel({ kind: 'trip', tripId: 12, day: '2026-10-02' }),
    );
    const day = { kind: 'day', day: '2026-09-29', occasion: 'work' } as const;
    expect(destinationPickLabel(day)).toContain('Tuesday');
    expect(destinationPickLabel({ ...day, replace: 42 })).not.toContain(
      'Tuesday',
    );
  });
});
