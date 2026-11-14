import { describe, expect, it } from 'vitest';
import {
  CUTOUT_STOP_MS,
  DOCKER_STOP_GRACE_MS,
  HEIC_DECODER_STOP_MS,
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

  it('stops the HEIC thread inside the cutout stop it runs beside', () => {
    expect(HEIC_DECODER_STOP_MS).toBeLessThanOrEqual(CUTOUT_STOP_MS);
  });
});
