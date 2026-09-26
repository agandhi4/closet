import { EntityManager } from '@mikro-orm/knex';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { describe, expect, it, vi } from 'vitest';
import { FileService } from '../file/file-service.abstract';
import {
  RECONCILE_CRON_JOB,
  StorageReconciliationService,
} from './storage-reconciliation.service';

// The reconciliation passes themselves are covered against the real app in
// test/integration/reconcile.spec.ts; this pins the cron guard's wiring.
const build = (maintenanceEnabled: boolean) => {
  const schedulerRegistry = { deleteCronJob: vi.fn() };
  const service = new StorageReconciliationService(
    {
      get: vi.fn((key: string) =>
        key === 'MAINTENANCE_ENABLED' ? maintenanceEnabled : undefined,
      ),
    } as unknown as ConfigService,
    {} as FileService,
    {} as EntityManager,
    schedulerRegistry as unknown as SchedulerRegistry,
  );
  return { service, schedulerRegistry };
};

describe('StorageReconciliationService cron guard', () => {
  it('leaves the nightly job registered when MAINTENANCE_ENABLED is true', () => {
    const { service, schedulerRegistry } = build(true);
    service.onApplicationBootstrap();
    expect(schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
  });

  it('removes the nightly job when MAINTENANCE_ENABLED is false', () => {
    const { service, schedulerRegistry } = build(false);
    service.onApplicationBootstrap();
    expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith(
      RECONCILE_CRON_JOB,
    );
  });

  it('logs instead of throwing when a scheduled run fails', async () => {
    const { service } = build(true);
    const failure = new Error('storage unreachable');
    vi.spyOn(service, 'reconcile').mockRejectedValue(failure);
    await expect(service.scheduled()).resolves.toBeUndefined();
  });
});
