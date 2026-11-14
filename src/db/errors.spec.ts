import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  DatabaseUnreachable,
  isDatabaseUnavailable,
  isLockTimeout,
  isUniqueViolation,
} from './errors';

/** A node-postgres error as the driver throws it. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('duplicate key value'), { code, constraint });
}

describe('isUniqueViolation', () => {
  it('answers for the constraint the caller names', () => {
    const error = pgError('23505', 'capsule_owner_id_lower_name_unique');
    expect(isUniqueViolation(error, 'capsule_owner_id_lower_name_unique')).toBe(
      true,
    );
  });

  it('is false for another unique constraint on the same write, so the caller rethrows', () => {
    const error = pgError('23505', 'user_pkey');
    expect(isUniqueViolation(error, 'user_lower_email_unique')).toBe(false);
  });

  it('reads the driver error through drizzle’s cause chain', () => {
    const wrapped = new Error('Failed query', {
      cause: pgError('23505', 'user_lower_email_unique'),
    });
    expect(isUniqueViolation(wrapped, 'user_lower_email_unique')).toBe(true);
  });

  it('is false for other errors', () => {
    expect(isUniqueViolation(pgError('23503'), 'user_lower_email_unique')).toBe(
      false,
    );
    expect(isUniqueViolation('boom', 'user_lower_email_unique')).toBe(false);
  });
});

describe('isLockTimeout', () => {
  it('is a lock wait past lock_timeout, read through drizzle’s cause chain', () => {
    const wrapped = new Error('Failed query', { cause: pgError('55P03') });
    expect(isLockTimeout(wrapped)).toBe(true);
  });

  it('is false for other errors, a statement timeout included', () => {
    expect(isLockTimeout(pgError('57014'))).toBe(false);
    expect(isLockTimeout(new Error('boom'))).toBe(false);
  });
});

describe('isDatabaseUnavailable', () => {
  const failedQuery = (cause: Error) =>
    new DrizzleQueryError('select 1', [], cause);
  const errno = (code: string) =>
    Object.assign(new Error(`connect ${code}`), { code });

  it('is a connection the pool could not open, whatever the driver said', () => {
    expect(
      isDatabaseUnavailable(new DatabaseUnreachable(errno('ECONNREFUSED'))),
    ).toBe(true);
    expect(
      isDatabaseUnavailable(
        failedQuery(new DatabaseUnreachable(new Error('timeout expired'))),
      ),
    ).toBe(true);
  });

  it('is the server going away: class 08 and 57P01-03', () => {
    for (const code of ['08006', '08001', '57P01', '57P02', '57P03']) {
      expect(isDatabaseUnavailable(failedQuery(pgError(code)))).toBe(true);
    }
  });

  it('is a connection lost under a query, by errno or by node-postgres’s message', () => {
    expect(isDatabaseUnavailable(failedQuery(errno('ECONNRESET')))).toBe(true);
    expect(
      isDatabaseUnavailable(failedQuery(new Error('Query read timeout'))),
    ).toBe(true);
  });

  // An outbound fetch's refused socket is not the database (#643).
  it('is false for a socket errno outside a query, a statement timeout and other failures', () => {
    expect(
      isDatabaseUnavailable(
        new TypeError('fetch failed', { cause: errno('ECONNREFUSED') }),
      ),
    ).toBe(false);
    expect(isDatabaseUnavailable(failedQuery(pgError('57014')))).toBe(false);
    expect(isDatabaseUnavailable(failedQuery(pgError('23505')))).toBe(false);
    expect(isDatabaseUnavailable('boom')).toBe(false);
  });
});
