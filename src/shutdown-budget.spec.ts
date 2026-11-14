import { describe, expect, it } from 'vitest';
import {
  DOCKER_STOP_GRACE_MS,
  SHUTDOWN_BOUNDED_MS,
  SHUTDOWN_BUDGET_MS,
} from './shutdown-budget';

describe('the shutdown budget', () => {
  it("fits its bounded phases in the budget, and the budget in docker stop's grace with a margin", () => {
    expect(SHUTDOWN_BOUNDED_MS).toBeLessThanOrEqual(SHUTDOWN_BUDGET_MS);
    expect(SHUTDOWN_BUDGET_MS).toBeLessThanOrEqual(
      DOCKER_STOP_GRACE_MS - 2_000,
    );
  });
});
