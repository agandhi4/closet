import { describe, expect, it } from 'vitest';
import { nextDraft } from './draft-queue';

describe('nextDraft', () => {
  const waiting = [
    { fileName: 'a', position: 0 },
    { fileName: 'c', position: 2 },
    { fileName: 'e', position: 4 },
  ];

  it('is the next in picked order after the position', () => {
    expect(nextDraft(waiting, 0, 'a')).toBe('c');
    // A position no longer waiting (b, just discarded) still finds c.
    expect(nextDraft(waiting, 1)).toBe('c');
  });

  it('wraps round to the first past the last', () => {
    expect(nextDraft(waiting, 4, 'e')).toBe('a');
  });

  it('is nothing when only the current one waits', () => {
    expect(nextDraft([{ fileName: 'a', position: 3 }], 3, 'a')).toBeUndefined();
    expect(nextDraft([], 0)).toBeUndefined();
  });
});
