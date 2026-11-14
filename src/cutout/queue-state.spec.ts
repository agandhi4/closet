import { describe, expect, it } from 'vitest';
import { ModelChecksumError, ModelDownloadError } from './model';
import {
  type CutoutQueueEvent,
  type CutoutQueueState,
  modelUnavailableKind,
  queueTransition,
} from './queue-state';
import { ModelBindingError } from './runner';

/** Runs `events` from stopped, one second apart: each step's state and capture. */
function run(events: CutoutQueueEvent[]) {
  let state: CutoutQueueState = { name: 'stopped' };
  return events.map((event, second) => {
    const step = queueTransition(state, event, second * 1000);
    state = step.state;
    return step;
  });
}

const unavailable = (
  kind: 'download' | 'checksum' | 'binding',
): CutoutQueueEvent => ({ type: 'model-unavailable', kind });

describe('queueTransition', () => {
  it('captures the first failure and each new kind of an outage, never a retry', () => {
    const steps = run([
      { type: 'start' },
      unavailable('download'),
      unavailable('download'),
      unavailable('checksum'),
      unavailable('download'),
      unavailable('checksum'),
    ]);
    expect(steps.map((step) => step.capture)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
    expect(steps.at(-1)!.state).toEqual({
      name: 'waiting-for-model',
      kind: 'checksum',
      since: 1000,
      captured: ['download', 'checksum'],
    });
  });

  it('ends the outage when the model is ready, and a later one is captured again', () => {
    const steps = run([
      { type: 'start' },
      unavailable('binding'),
      unavailable('binding'),
      { type: 'model-ready' },
      { type: 'model-ready' },
      unavailable('binding'),
    ]);
    expect(steps[3]).toEqual({
      state: { name: 'running' },
      capture: false,
      recoveredAfterMs: 2000,
    });
    // Ready while running is no recovery.
    expect(steps[4]).toEqual({ state: { name: 'running' }, capture: false });
    expect(steps[5]).toMatchObject({
      state: { name: 'waiting-for-model', since: 5000 },
      capture: true,
    });
  });

  it('stays stopped for what a loop still ending reports, and refuses a second start', () => {
    const steps = run([
      { type: 'start' },
      unavailable('download'),
      { type: 'stop' },
      unavailable('checksum'),
      { type: 'model-ready' },
    ]);
    expect(steps.slice(2)).toEqual([
      { state: { name: 'stopped' }, capture: false },
      { state: { name: 'stopped' }, capture: false },
      { state: { name: 'stopped' }, capture: false },
    ]);
    expect(() =>
      queueTransition({ name: 'running' }, { type: 'start' }, 0),
    ).toThrow('The cutout queue cannot start while running');
  });
});

describe('a disabled queue (CUTOUT_ENABLED=false)', () => {
  const disabled = queueTransition({ name: 'stopped' }, { type: 'disable' }, 0);

  it('is terminal: nothing leaves it, and start is refused', () => {
    expect(disabled).toEqual({ state: { name: 'disabled' }, capture: false });
    for (const event of [
      { type: 'stop' },
      { type: 'model-ready' },
      unavailable('download'),
    ] as const) {
      expect(queueTransition(disabled.state, event, 1)).toEqual(disabled);
    }
    expect(() => queueTransition(disabled.state, { type: 'start' }, 0)).toThrow(
      'The cutout queue cannot start while disabled',
    );
    expect(() =>
      queueTransition({ name: 'running' }, { type: 'disable' }, 0),
    ).toThrow('The cutout queue cannot be disabled while running');
  });
});

describe('modelUnavailableKind', () => {
  it.each([
    ['download', new ModelDownloadError('Model download failed: HTTP 403')],
    ['checksum', new ModelChecksumError('/models/m.onnx', 'aa', 'bb')],
    ['binding', new ModelBindingError('exited with code 1')],
    [
      'permission',
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    ],
    [
      'permission',
      Object.assign(new Error('EROFS: read-only'), { code: 'EROFS' }),
    ],
    ['other', Object.assign(new Error('no space'), { code: 'ENOSPC' })],
    ['other', 'not even an error'],
  ])('reads %s', (kind, error) => {
    expect(modelUnavailableKind(error)).toBe(kind);
  });
});
