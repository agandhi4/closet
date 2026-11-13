import { describe, expect, it } from 'vitest';
import { isApiPath } from './api-path';

// The rule surfaceOf and bypassesWorker share: a spelling one takes for the
// API and the other for a page would let the worker cache an API answer.
describe('isApiPath', () => {
  it.each([
    '/api',
    '/api/',
    '/api/v1/me',
    '/API/v1/me',
    '/Api?x=1',
    '/api#x',
    '/api/v2',
  ])('is the API at %s', (path) => {
    expect(isApiPath(path)).toBe(true);
  });

  it.each(['/apix', '/API2', '/wardrobe', '/', '/x/api', 'api/v1'])(
    'is not the API at %s',
    (path) => {
      expect(isApiPath(path)).toBe(false);
    },
  );
});
