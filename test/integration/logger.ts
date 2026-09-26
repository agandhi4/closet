import type { WebLogger } from '../../src/web/logger';

/** For specs that call a plain module directly and do not assert its logs. */
export const silentLogger: WebLogger = {
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
