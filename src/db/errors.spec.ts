import { describe, expect, it } from 'vitest';
import { isLockTimeout, isUniqueViolation } from './errors';

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
    const error = pgError('23505', 'wardrobe_plan_owner_id_active_unique');
    expect(
      isUniqueViolation(error, 'wardrobe_plan_owner_id_lower_name_unique'),
    ).toBe(false);
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
