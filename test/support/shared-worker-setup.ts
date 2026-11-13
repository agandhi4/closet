import { afterAll, expect, vi } from 'vitest';
import { enumerablePrototypeKeys } from './prototype-hygiene';

/**
 * Per spec file of the integration project, whose workers share one module
 * graph across files (`isolate: false`, vitest.config.mts): whatever process
 * state a file changed through `vi` ends with the file, so the next file in
 * the worker starts from real timers, the real environment and real globals.
 * Vitest itself restores spies between files; it does not restore these.
 *
 * Nor can anything restore a built-in prototype a module extended at import,
 * so the file that loaded it fails instead: every later app in the worker
 * would see the key (#620, prototype-hygiene.ts).
 */
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(
    enumerablePrototypeKeys(),
    'a module this file imported added enumerable keys to a built-in prototype: hide them where it is imported (hidePrototypeExtensions)',
  ).toEqual([]);
});
