import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { commandStop } from './cli';

/**
 * A stoppable command's `stop` against a stand-in for `process`: the first
 * signal stops the work in flight; the second must still end the process,
 * which Node does only when no listener is left for it.
 */
describe('commandStop', () => {
  const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
  const listeners = (signals: EventEmitter) =>
    SIGNALS.map((signal) => signals.listenerCount(signal));

  it.each(SIGNALS)(
    'is aborted by the first %s, which leaves no listener for a second signal',
    (first) => {
      const signals = new EventEmitter();
      const { logger, logs } = captureLogs();
      const stop = commandStop({ stoppable: true }, signals, logger);
      expect(stop.aborted).toBe(false);
      expect(listeners(signals)).toEqual([1, 1]);

      signals.emit(first, first);

      expect(stop.aborted).toBe(true);
      expect(logs.messages('warn')).toEqual([
        `${first}: finishing the work in flight, then stopping (again to kill)`,
      ]);
      // Neither signal has a listener now: the next one, either, kills.
      expect(listeners(signals)).toEqual([0, 0]);
    },
  );

  it('takes no signal from a command that is not stoppable', () => {
    const signals = new EventEmitter();
    const { logger, logs } = captureLogs();
    const stop = commandStop({}, signals, logger);

    expect(listeners(signals)).toEqual([0, 0]);
    expect(stop.aborted).toBe(false);
    expect(logs.records).toEqual([]);
  });
});
