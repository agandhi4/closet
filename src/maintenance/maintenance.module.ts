import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FileModule } from '../file/file.module';
import { StorageReconciliationService } from './storage-reconciliation.service';

// ScheduleModule is imported here, not in AppModule, on purpose: it must
// bootstrap before StorageReconciliationService so the MAINTENANCE_ENABLED
// guard finds the cron job already registered (see onApplicationBootstrap).
@Module({
  imports: [ScheduleModule.forRoot(), FileModule],
  providers: [StorageReconciliationService],
  exports: [StorageReconciliationService],
})
export class MaintenanceModule {}
