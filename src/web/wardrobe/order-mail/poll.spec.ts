import { describe, expect, it } from 'vitest';
import { DatabaseUnreachable, PoolExhausted } from '../../../db/errors';
import { JmapError } from './jmap';
import { failureScope } from './poll';

const sqlstate = (code: string) =>
  Object.assign(new Error(`SQLSTATE ${code}`), { code });

describe('failureScope (#932, #933)', () => {
  it.each([
    ['the database unreachable', new DatabaseUnreachable(new Error('down'))],
    ['its pool exhausted', new PoolExhausted(new Error('busy'))],
    ['a statement timeout', sqlstate('57014')],
    ['a lock not available', sqlstate('55P03')],
    ['a serialization failure', sqlstate('40001')],
    ['a deadlock', sqlstate('40P01')],
    ['the server shutting down', sqlstate('57P01')],
    ['a JMAP session failure', new JmapError('session')],
  ])('is an outage for %s: no attempt, no strike', (_, error) => {
    expect(failureScope(error)).toBe('outage');
  });

  it('is the email for a value its columns refuse', () => {
    expect(failureScope(sqlstate('22003'))).toBe('email');
  });

  it("takes a JMAP error's own scope", () => {
    expect(failureScope(new JmapError('x', { scope: 'message' }))).toBe(
      'message',
    );
    expect(failureScope(new JmapError('x', { scope: 'email' }))).toBe('email');
  });
});
