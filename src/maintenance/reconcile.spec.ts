import { describe, expect, it } from 'vitest';
import { guardRefusal } from './reconcile';

// The thresholds at their edges; test/integration/reconcile-guard.spec.ts
// proves a refused run deletes nothing.
describe('guardRefusal', () => {
  it.each([
    [{ rows: 0, storedPhotoSets: 0, deletions: 0 }, undefined],
    [{ rows: 10, storedPhotoSets: 10, deletions: 0 }, undefined],
    [{ rows: 175, storedPhotoSets: 200, deletions: 25 }, undefined],
    [{ rows: 24, storedPhotoSets: 30, deletions: 6 }, undefined],
    [{ rows: 1, storedPhotoSets: 6, deletions: 5 }, undefined],
    [{ rows: 0, storedPhotoSets: 3, deletions: 3 }, /file table is empty/],
    [{ rows: 174, storedPhotoSets: 200, deletions: 26 }, /more than 25/],
    [{ rows: 23, storedPhotoSets: 30, deletions: 7 }, /7 of 30 .*20%/],
  ])('%o -> %s', (counts, expected) => {
    const refusal = guardRefusal(counts);
    if (expected) expect(refusal).toMatch(expected);
    else expect(refusal).toBeUndefined();
  });
});
