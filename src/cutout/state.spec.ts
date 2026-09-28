import { describe, expect, it } from 'vitest';
import {
  CUTOUT_STATUSES,
  type CutoutEvent,
  type CutoutState,
  type CutoutStatus,
  initialCutoutState,
  showsCutout,
  transition,
} from './state';

const WORKER = 'linux-box:1:0a1b2c3d';
const KEY = 'a1b2c3d4e5f6';

const at = (
  status: CutoutStatus,
  overrides: Partial<CutoutState> = {},
): CutoutState => ({
  status,
  version: 3,
  attempts: 1,
  jobVersion: status === 'pending' ? 3 : null,
  worker: status === 'pending' ? WORKER : null,
  variantKey: null,
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
        state: {
          status: 'pending',
          version: 3,
          attempts: 0,
          jobVersion: null,
          worker: null,
          variantKey: null,
        },
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
        state: {
          status: 'pending',
          version: 3,
          attempts: 2,
          jobVersion: null,
          worker: null,
          variantKey: null,
        },
      });
    });

    // A pending row is queued or running already: requeueing a running job
    // would discard its result and run the model a second time.
    it.each(refusedFrom({ type: 'retry' }, ['failed']))(
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
    it('counts the attempt, records the photo version and leases the row', () => {
      expect(
        transition(
          at('pending', { attempts: 0, jobVersion: null, worker: null }),
          { type: 'start', worker: WORKER },
        ),
      ).toEqual({
        ok: true,
        queued: false,
        state: {
          status: 'pending',
          version: 3,
          attempts: 1,
          jobVersion: 3,
          worker: WORKER,
          variantKey: null,
        },
      });
    });

    it('takes over a lapsed lease (the claim offers only those)', () => {
      expect(
        transition(at('pending', { worker: 'crashed:1:ffffffff' }), {
          type: 'start',
          worker: WORKER,
        }),
      ).toMatchObject({ ok: true, state: { attempts: 2, worker: WORKER } });
    });

    it.each(refusedFrom({ type: 'start', worker: WORKER }, ['pending']))(
      'is refused from %s',
      (status, event) => {
        expect(transition(at(status), event)).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
      },
    );
  });

  describe('release', () => {
    it("frees its own lease, keeping the attempt and the queue's place", () => {
      expect(
        transition(at('pending'), { type: 'release', worker: WORKER }),
      ).toEqual({
        ok: true,
        queued: false,
        state: {
          status: 'pending',
          version: 3,
          attempts: 1,
          jobVersion: null,
          worker: null,
          variantKey: null,
        },
      });
    });

    it('leaves a lease another worker took since alone', () => {
      expect(
        transition(at('pending', { worker: 'other:2:12345678' }), {
          type: 'release',
          worker: WORKER,
        }),
      ).toEqual({ ok: false, reason: 'stale' });
    });

    it.each(refusedFrom({ type: 'release', worker: WORKER }, ['pending']))(
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
    it('makes the cutout ready under a new version and key', () => {
      expect(
        transition(at('pending'), {
          type: 'succeed',
          jobVersion: 3,
          variantKey: KEY,
        }),
      ).toEqual({
        ok: true,
        queued: false,
        state: {
          status: 'ready',
          version: 4,
          attempts: 1,
          jobVersion: null,
          worker: null,
          variantKey: KEY,
        },
      });
    });

    it('discards a result for another photo version', () => {
      expect(
        transition(at('pending', { version: 4, jobVersion: 4 }), {
          type: 'succeed',
          jobVersion: 3,
          variantKey: KEY,
        }),
      ).toEqual({ ok: false, reason: 'stale' });
    });

    it('discards a result for a job that was requeued meanwhile', () => {
      expect(
        transition(at('pending', { jobVersion: null, worker: null }), {
          type: 'succeed',
          jobVersion: 3,
          variantKey: KEY,
        }),
      ).toEqual({ ok: false, reason: 'stale' });
    });

    it.each(
      refusedFrom({ type: 'succeed', jobVersion: 3, variantKey: KEY }, [
        'pending',
      ]),
    )('never overwrites a %s cutout', (status, event) => {
      expect(transition(at(status), event)).toEqual({
        ok: false,
        reason: 'not-allowed',
      });
    });
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
        state: {
          status: 'failed',
          version: 3,
          attempts: 2,
          jobVersion: null,
          worker: null,
          variantKey: null,
        },
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
    const EDITABLE = CUTOUT_STATUSES.filter((status) => status !== 'unwanted');

    it.each(EDITABLE)(
      'takes the user mask from %s under a new version and key',
      (status) => {
        expect(
          transition(at(status), { type: 'edit', variantKey: KEY }),
        ).toEqual({
          ok: true,
          queued: false,
          state: {
            status: 'edited',
            version: 4,
            attempts: 1,
            jobVersion: null,
            worker: null,
            variantKey: KEY,
          },
        });
      },
    );

    it("points at the new mask's bytes, never the earlier cutout's", () => {
      expect(
        transition(at('ready', { variantKey: '0123456789ab' }), {
          type: 'edit',
          variantKey: KEY,
        }),
      ).toMatchObject({ ok: true, state: { variantKey: KEY, version: 4 } });
    });

    it.each(refusedFrom({ type: 'edit', variantKey: KEY }, EDITABLE))(
      'is refused from %s (a selfie keeps its background)',
      (status, event) => {
        expect(transition(at(status), event)).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
      },
    );
  });

  // A selfie is never queued, so never claimed: no event, the lease's
  // start and release included, applies to it (file_cutout_lease_check
  // also allows a lease only on a pending row).
  it.each<CutoutEvent>([
    { type: 'request' },
    { type: 'retry' },
    { type: 'start', worker: WORKER },
    { type: 'release', worker: WORKER },
    { type: 'succeed', jobVersion: 3, variantKey: KEY },
    { type: 'fail', jobVersion: 3 },
    { type: 'edit', variantKey: KEY },
  ])('leaves an unwanted cutout alone: $type', (event) => {
    expect(transition(at('unwanted'), event)).toEqual({
      ok: false,
      reason: 'not-allowed',
    });
  });

  it('a job cannot land on an edit made while it ran', () => {
    const started = transition(
      at('pending', { jobVersion: null, worker: null }),
      { type: 'start', worker: WORKER },
    );
    if (!started.ok) throw new Error('start refused');
    const edited = transition(started.state, { type: 'edit', variantKey: KEY });
    if (!edited.ok) throw new Error('edit refused');
    expect(
      transition(edited.state, {
        type: 'succeed',
        jobVersion: 3,
        variantKey: KEY,
      }),
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

describe('showsCutout', () => {
  it('is the cut-out statuses, never the photo as taken', () => {
    const shown = CUTOUT_STATUSES.filter(showsCutout);
    expect(shown).toEqual(['none', 'ready', 'edited']);
  });
});
