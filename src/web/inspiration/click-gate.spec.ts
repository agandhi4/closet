import { afterEach, describe, expect, it, vi } from 'vitest';
// share-confirm.js's Save look (public/js/ is served as it is, not built):
// the gate's decisions are these pure helpers, tested here.
import { clickAllowed, visibleFor } from '../../../public/js/click-gate.js';

/** A document whose visibility the test sets, firing visibilitychange. */
function fakeDocument(initial: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial,
    addEventListener: (_type: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      listeners.delete(listener),
  };
  const become = (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    for (const listener of listeners) listener();
  };
  return { doc, become, listeners };
}

// The share confirmation's click-timing defence (#22d): a page must not be
// able to time a tap to the moment Save look appears under the finger.
describe('clickAllowed', () => {
  // Save opened at 1000 (performance.now() time), or never (Infinity).
  it.each([
    [
      'a click before Save opened',
      1000,
      { timeStamp: 999, detail: 1 },
      999,
      false,
    ],
    [
      'a pointer click whose pointerdown came before Save opened',
      1000,
      { timeStamp: 1200, detail: 1 },
      990,
      false,
    ],
    [
      'a pointer click whose whole gesture came after',
      1000,
      { timeStamp: 1200, detail: 1 },
      1100,
      true,
    ],
    [
      'a keyboard click after, whatever tap came before',
      1000,
      { timeStamp: 1200, detail: 0 },
      -Infinity,
      true,
    ],
    [
      'any click while Save is shut',
      Infinity,
      { timeStamp: 5000, detail: 0 },
      4000,
      false,
    ],
  ] as const)('%s', (_case, openedAt, click, pointerDownAt, allowed) => {
    expect(clickAllowed(click, openedAt, pointerDownAt)).toBe(allowed);
  });
});

describe('visibleFor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves only after the delay on a visible page, restarting when the page was hidden', async () => {
    vi.useFakeTimers();
    const { doc, become, listeners } = fakeDocument('visible');
    let open = false;
    void visibleFor(doc, 800).then(() => {
      open = true;
    });
    await vi.advanceTimersByTimeAsync(700);
    become('hidden');
    await vi.advanceTimersByTimeAsync(2000);
    expect(open).toBe(false);
    become('visible');
    await vi.advanceTimersByTimeAsync(799);
    expect(open).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('waits for a page opened in the background to be seen', async () => {
    vi.useFakeTimers();
    const { doc, become } = fakeDocument('hidden');
    let open = false;
    void visibleFor(doc, 800).then(() => {
      open = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(open).toBe(false);
    become('visible');
    await vi.advanceTimersByTimeAsync(800);
    expect(open).toBe(true);
  });
});
