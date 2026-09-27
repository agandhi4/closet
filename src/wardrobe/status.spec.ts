import { describe, expect, it } from 'vitest';
import {
  ENTRY_STATUSES,
  GARMENT_STATUS_EVENTS,
  GARMENT_STATUSES,
  type GarmentStatus,
  type GarmentStatusEvent,
  garmentStatusTransition,
  statusOfClone,
} from './status';

/** Every edge the machine allows, as (from, event, to). */
const ALLOWED: [GarmentStatus, GarmentStatusEvent, GarmentStatus][] = [
  ['wishlist', 'buy', 'closet'],
  ['closet', 'archive', 'archived'],
  ['archived', 'restore', 'closet'],
];

const allowed = (status: GarmentStatus, event: GarmentStatusEvent) =>
  ALLOWED.some(([from, on]) => from === status && on === event);

/** Every (status, event) pair the machine refuses. */
const REFUSED = GARMENT_STATUSES.flatMap((status) =>
  GARMENT_STATUS_EVENTS.filter((event) => !allowed(status, event)).map(
    (event) => [status, event] as const,
  ),
);

describe('garment status machine', () => {
  it.each(ALLOWED)('%s --%s--> %s', (from, event, to) => {
    expect(garmentStatusTransition(from, event)).toEqual({
      ok: true,
      from,
      to,
    });
  });

  it.each(REFUSED)('refuses %s on %s', (status, event) => {
    expect(garmentStatusTransition(status, event)).toEqual({
      ok: false,
      status,
    });
  });

  it('checks every pair: 3 statuses by 3 events', () => {
    expect(ALLOWED.length + REFUSED.length).toBe(9);
  });

  it('never moves a garment onto the wishlist, and off it only by buying', () => {
    const moves = GARMENT_STATUSES.flatMap((status) =>
      GARMENT_STATUS_EVENTS.map((event) => ({
        status,
        event,
        result: garmentStatusTransition(status, event),
      })),
    ).filter(({ result }) => result.ok);
    expect(moves.map(({ result }) => result.ok && result.to)).not.toContain(
      'wishlist',
    );
    expect(
      moves.filter(({ status }) => status === 'wishlist').map((m) => m.event),
    ).toEqual(['buy']);
  });

  it('never archives a wishlist item: dropping one is a delete', () => {
    expect(garmentStatusTransition('wishlist', 'archive').ok).toBe(false);
  });

  it('starts a new garment in the closet or on the wishlist, never archived', () => {
    expect(ENTRY_STATUSES).toEqual(['closet', 'wishlist']);
  });

  it.each([
    ['closet', 'closet'],
    ['archived', 'closet'],
    ['wishlist', 'wishlist'],
  ] as const)('a clone of a %s garment starts in %s', (source, clone) => {
    expect(statusOfClone(source)).toBe(clone);
  });
});
