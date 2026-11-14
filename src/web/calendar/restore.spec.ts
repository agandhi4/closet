import { describe, expect, it } from 'vitest';
import { createUndoStore, type RemovedEntry } from './restore';

const ENTRY: RemovedEntry = {
  outfitId: 7,
  day: '2030-10-14',
  occasion: 'work',
  plannedBy: 'auto',
};

describe('the undo store', () => {
  it('hands a snapshot back once, to its owner only', () => {
    const store = createUndoStore();
    const token = store.put(1, ENTRY);
    expect(store.take(2, token)).toBeUndefined();
    expect(store.take(1, token)).toEqual(ENTRY);
    expect(store.take(1, token)).toBeUndefined();
  });

  it('forgets a snapshot once its time is up', () => {
    let now = 0;
    const store = createUndoStore(() => now);
    const token = store.put(1, ENTRY);
    now = 31_000;
    expect(store.take(1, token)).toBeUndefined();
  });

  it('knows no token the client invents', () => {
    expect(createUndoStore().take(1, 'forged')).toBeUndefined();
  });
});
