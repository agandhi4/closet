import { afterAll, vi } from 'vitest';

/**
 * Per spec file of the integration project, whose workers share one module
 * graph across files (`isolate: false`, vitest.config.ts): whatever process
 * state a file changed through `vi` ends with the file, so the next file in
 * the worker starts from real timers, the real environment and real globals.
 * Vitest itself restores spies between files; it does not restore these.
 */
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
