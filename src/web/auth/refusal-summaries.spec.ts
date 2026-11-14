import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import { RefusalSummaries } from './refusal-summaries';

describe('RefusalSummaries', () => {
  const setup = () => {
    const { logger, logs } = captureLogs();
    let now = 1_000;
    const summaries = new RefusalSummaries(logger, () => now);
    return {
      summaries,
      lines: () => logs.messages('warn'),
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('writes one line per address once its window has ended, with counts by kind', () => {
    const { summaries, lines, advance } = setup();
    summaries.suppress('a', 'revoked token', 60_000);
    summaries.suppress('a', 'revoked token', 60_000);
    summaries.suppress('a', 'unknown token, 429', 60_000);
    summaries.flushEnded();
    expect(lines()).toEqual([]);
    advance(60_000);
    summaries.flushEnded();
    expect(lines()).toEqual([
      '3 further credential refusals from a past its budget, not logged one by one (revoked token x2, unknown token, 429 x1)',
    ]);
    summaries.flushEnded();
    expect(lines()).toHaveLength(1);
  });

  it('closes a stale window on the same address before counting the next', () => {
    const { summaries, lines, advance } = setup();
    summaries.suppress('a', 'revoked token', 1_000);
    advance(1_000);
    summaries.suppress('a', 'revoked token', 1_000);
    expect(lines()).toHaveLength(1);
    advance(1_000);
    summaries.flushEnded();
    expect(lines()).toHaveLength(2);
  });

  it('holds a bounded number of addresses, summarising the oldest to make room', () => {
    const { summaries, lines } = setup();
    for (let n = 0; n < 1_000; n += 1) {
      summaries.suppress(`ip-${n}`, 'revoked token', 60_000);
    }
    expect(lines()).toEqual([]);
    summaries.suppress('one-more', 'revoked token', 60_000);
    expect(lines()).toEqual([
      expect.stringContaining('from ip-0 past its budget'),
    ]);
  });
});
