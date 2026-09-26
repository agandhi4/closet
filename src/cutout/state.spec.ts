import { describe, expect, it } from 'vitest';
import {
  CUTOUT_STATUSES,
  type CutoutEvent,
  type CutoutState,
  type CutoutStatus,
  initialCutoutState,
  transition,
} from './state';

const at = (
  status: CutoutStatus,
  overrides: Partial<CutoutState> = {},
): CutoutState => ({
  status,
  version: 3,
  attempts: 1,
  jobVersion: status === 'pending' ? 3 : null,
  ...overrides,
});

/** Every status an event is refused from, as not-allowed. */
function refusedFrom(event: CutoutEvent, allowed: CutoutStatus[]) {
  return CUTOUT_STATUSES.filter((status) => !allowed.includes(status)).map(
    (status) => [status, event] as const,
  );
}

describe('cutout state machine', () => {
  describe('request', () => {
    it('queues a photo that has no cutout yet', () => {
      expect(
        transition(at('none', { attempts: 0 }), { type: 'request' }),
      ).toEqual({
        ok: true,
        queued: true,
        state: { status: 'pending', version: 3, attempts: 0, jobVersion: null },
      });
    });

    it.each(refusedFrom({ type: 'request' }, ['none']))(
      'is refused from %s',
      (status, event) => {
        expect(transition(at(status), event)).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
      },
    );
  });

  describe('retry', () => {
    it('requeues a failed cutout, keeping its attempts', () => {
      expect(
        transition(at('failed', { attempts: 2 }), { type: 'retry' }),
      ).toEqual({
        ok: true,
        queued: true,
        state: { status: 'pending', version: 3, attempts: 2, jobVersion: null },
      });
    });

    it('requeues a pending one, detaching the job that may be running', () => {
      expect(transition(at('pending'), { type: 'retry' })).toEqual({
        ok: true,
        queued: true,
        state: { status: 'pending', version: 3, attempts: 1, jobVersion: null },
      });
    });

    it.each(refusedFrom({ type: 'retry' }, ['pending', 'failed']))(
      'is refused from %s',
      (status, event) => {
        expect(transition(at(status), event)).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
      },
    );
  });

  describe('start', () => {
    it('counts the attempt and records the photo version the job runs for', () => {
      expect(
        transition(at('pending', { attempts: 0, jobVersion: null }), {
          type: 'start',
        }),
      ).toEqual({
        ok: true,
        queued: false,
        state: { status: 'pending', version: 3, attempts: 1, jobVersion: 3 },
      });
    });

    it.each(refusedFrom({ type: 'start' }, ['pending']))(
      'is refused from %s',
      (status, event) => {
        expect(transition(at(status), event)).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
      },
    );
  });

  describe('succeed', () => {
    it('makes the cutout ready under a new version', () => {
      expect(
        transition(at('pending'), { type: 'succeed', jobVersion: 3 }),
      ).toEqual({
        ok: true,
        queued: false,
        state: { status: 'ready', version: 4, attempts: 1, jobVersion: null },
      });
    });

    it('discards a result for another photo version', () => {
      expect(
        transition(at('pending', { version: 4, jobVersion: 4 }), {
          type: 'succeed',
          jobVersion: 3,
        }),
      ).toEqual({ ok: false, reason: 'stale' });
    });

    it('discards a result for a job that was requeued meanwhile', () => {
      expect(
        transition(at('pending', { jobVersion: null }), {
          type: 'succeed',
          jobVersion: 3,
        }),
      ).toEqual({ ok: false, reason: 'stale' });
    });

    it.each(refusedFrom({ type: 'succeed', jobVersion: 3 }, ['pending']))(
      'never overwrites a %s cutout',
      (status, event) => {
        expect(transition(at(status), event)).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
      },
    );
  });

  describe('fail', () => {
    it('marks the cutout failed without a new version', () => {
      expect(
        transition(at('pending', { attempts: 2 }), {
          type: 'fail',
          jobVersion: 3,
        }),
      ).toEqual({
        ok: true,
        queued: false,
        state: { status: 'failed', version: 3, attempts: 2, jobVersion: null },
      });
    });

    it('discards a failure for another photo version', () => {
      expect(
        transition(at('pending', { version: 5, jobVersion: 5 }), {
          type: 'fail',
          jobVersion: 3,
        }),
      ).toEqual({ ok: false, reason: 'stale' });
    });

    it.each(refusedFrom({ type: 'fail', jobVersion: 3 }, ['pending']))(
      'leaves a %s cutout alone',
      (status, event) => {
        expect(transition(at(status), event)).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
      },
    );
  });

  describe('edit', () => {
    it.each(CUTOUT_STATUSES)(
      'takes the user mask from %s under a new version',
      (status) => {
        expect(transition(at(status), { type: 'edit' })).toEqual({
          ok: true,
          queued: false,
          state: {
            status: 'edited',
            version: 4,
            attempts: 1,
            jobVersion: null,
          },
        });
      },
    );
  });

  it('a job cannot land on an edit made while it ran', () => {
    const started = transition(at('pending', { jobVersion: null }), {
      type: 'start',
    });
    if (!started.ok) throw new Error('start refused');
    const edited = transition(started.state, { type: 'edit' });
    if (!edited.ok) throw new Error('edit refused');
    expect(
      transition(edited.state, { type: 'succeed', jobVersion: 3 }),
    ).toEqual({ ok: false, reason: 'not-allowed' });
  });
});

describe('initialCutoutState', () => {
  it('queues a pending row now', () => {
    const before = Date.now();
    const state = initialCutoutState('pending');
    expect(state).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 0,
      cutoutJobVersion: null,
    });
    expect(state.cutoutRequestedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('gives any other status no place in the queue', () => {
    expect(initialCutoutState('ready')).toEqual({
      cutoutStatus: 'ready',
      cutoutAttempts: 0,
      cutoutJobVersion: null,
      cutoutRequestedAt: null,
    });
  });
});
