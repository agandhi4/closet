import { EntityManager } from '@mikro-orm/knex';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { File } from '../dal/entity/file.entity';
import { Garment } from '../dal/entity/garment.entity';
import { parseStoredName } from '../web/files/image-variant';
import { Photos } from '../web/files/photos';

export const RECONCILE_CRON_JOB = 'storage-reconciliation';

// Younger objects and rows are left alone: an upload writes its bytes before
// its row exists, and a delete removes the row before the bytes, so anything
// under a day old may simply be in flight.
export const DEFAULT_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

export interface ReconcileOptions {
  olderThanMs?: number;
  /** Count and log what would change without deleting anything. */
  dryRun?: boolean;
}

export interface ReconciliationReport {
  dryRun: boolean;
  /** Objects the backend listed, photos or not. */
  storedObjects: number;
  /** Photo sets (original plus variants) in storage with no File row. */
  orphanedObjectsDeleted: number;
  /** File rows no garment points at. */
  orphanedRowsDeleted: number;
  /** File rows whose original is gone from storage; reported, never deleted. */
  missingOriginals: number;
  durationMs: number;
}

interface StoredPhotoSet {
  names: string[];
  /** undefined when the backend gave no timestamp for some object: treated as new. */
  newest: Date | undefined;
}

// undefined is sticky: one object without a timestamp makes the set "new".
function newestOf(
  current: Date | undefined,
  next: Date | undefined,
): Date | undefined {
  if (!current || !next) return undefined;
  return next > current ? next : current;
}

/**
 * Keeps storage and the file table describing each other. Three passes, each
 * bounded by `olderThan`:
 *   storage -> rows   objects whose base name has no File row are deleted
 *   rows -> garments  File rows no Garment.photo references are deleted, with
 *                     their variants, one transaction per row
 *   rows -> storage   File rows whose original is missing are reported
 * Garment.photo is the only relation that references File (see the entities),
 * so an unreferenced row is an orphan by definition.
 *
 * Runs nightly (`@Cron`) unless MAINTENANCE_ENABLED is false, and on demand
 * through `npm run maintenance:reconcile` (reconcile.cli.ts).
 */
@Injectable()
export class StorageReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageReconciliationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly photos: Photos,
    private readonly em: EntityManager,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // ScheduleModule mounts every @Cron job in its own onApplicationBootstrap,
  // which runs before this one because MaintenanceModule imports it (Nest
  // bootstraps deeper modules first). Removing the job here is what keeps the
  // integration harness and one-off CLI runs free of a live timer.
  onApplicationBootstrap(): void {
    if (this.configService.get<boolean>('MAINTENANCE_ENABLED')) {
      this.logger.log('Storage reconciliation scheduled daily at 03:00');
      return;
    }
    this.schedulerRegistry.deleteCronJob(RECONCILE_CRON_JOB);
    this.logger.log(
      'Storage reconciliation disabled (MAINTENANCE_ENABLED=false)',
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: RECONCILE_CRON_JOB,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(`Scheduled storage reconciliation failed: ${error}`);
    }
  }

  async reconcile({
    olderThanMs = DEFAULT_OLDER_THAN_MS,
    dryRun = false,
  }: ReconcileOptions = {}): Promise<ReconciliationReport> {
    const startedAt = Date.now();
    const cutoff = new Date(startedAt - olderThanMs);
    this.logger.log(
      `Storage reconciliation started${dryRun ? ' (dry run)' : ''}, cutoff ${cutoff.toISOString()}`,
    );
    const em = this.em.fork();

    // One listing serves all passes. Rows removed by the second pass (or that
    // a dry run would remove) count as handled in the storage pass, so their
    // bytes are neither deleted twice nor counted as a second orphan.
    const { photoSets, storedObjects } = await this.scanStorage();
    const removedRows = await this.removeUnreferencedRows(em, cutoff, dryRun);
    const rows = (
      await em.find(File, {}, { fields: ['fileName', 'createdOn'] })
    ).filter((row) => !removedRows.has(row.id));
    const orphanedObjectsDeleted = await this.removeOrphanedObjects(
      photoSets,
      new Set([...rows.map((row) => row.fileName), ...removedRows.values()]),
      cutoff,
      dryRun,
    );
    const missingOriginals = this.reportMissingOriginals(
      rows,
      photoSets,
      cutoff,
    );

    const report: ReconciliationReport = {
      dryRun,
      storedObjects,
      orphanedObjectsDeleted,
      orphanedRowsDeleted: removedRows.size,
      missingOriginals,
      durationMs: Date.now() - startedAt,
    };
    this.logger.log(
      `Storage reconciliation ${dryRun ? 'dry run ' : ''}done in ${report.durationMs}ms: ` +
        `${storedObjects} objects scanned, ${orphanedObjectsDeleted} orphaned photo sets ` +
        `and ${removedRows.size} orphaned rows ${dryRun ? 'would be ' : ''}deleted, ` +
        `${missingOriginals} rows missing their original`,
    );
    return report;
  }

  // One listing serves all three passes; objects that are not photos (the
  // app.log) are counted and otherwise ignored.
  private async scanStorage(): Promise<{
    photoSets: Map<string, StoredPhotoSet>;
    storedObjects: number;
  }> {
    const photoSets = new Map<string, StoredPhotoSet>();
    let storedObjects = 0;
    for await (const object of this.photos.storage.list()) {
      storedObjects += 1;
      const parsed = parseStoredName(object.name);
      if (!parsed) continue;
      const set = photoSets.get(parsed.baseName) ?? {
        names: [],
        newest: new Date(0),
      };
      set.names.push(object.name);
      set.newest = newestOf(set.newest, object.lastModified);
      photoSets.set(parsed.baseName, set);
    }
    return { photoSets, storedObjects };
  }

  private async removeOrphanedObjects(
    photoSets: Map<string, StoredPhotoSet>,
    knownFileNames: Set<string>,
    cutoff: Date,
    dryRun: boolean,
  ): Promise<number> {
    let deleted = 0;
    for (const [baseName, set] of photoSets) {
      if (knownFileNames.has(baseName)) continue;
      if (!set.newest || set.newest >= cutoff) {
        this.logger.debug(`Keeping recent orphan ${baseName}`);
        continue;
      }
      this.logger.debug(
        `${dryRun ? 'Would delete' : 'Deleting'} orphaned ${set.names.join(', ')}`,
      );
      if (!dryRun) await this.photos.deleteVariants(baseName);
      deleted += 1;
    }
    return deleted;
  }

  // Each row goes in its own transaction with a fresh reference check, so a
  // garment attached since the scan keeps its photo. Bytes go after commit;
  // an unlink cannot be rolled back.
  private async removeUnreferencedRows(
    em: EntityManager,
    cutoff: Date,
    dryRun: boolean,
  ): Promise<Map<number, string>> {
    const removed = new Map<number, string>();
    for (const candidate of await this.findUnreferencedRows(em, cutoff)) {
      // One bad row (deadlock, dropped connection) must not cancel the whole
      // sweep; it stays a candidate for the next run.
      try {
        const fileName = await em.transactional(async (tem) => {
          const inUse = await tem.count(Garment, { photo: candidate.id });
          if (inUse) return undefined;
          if (!dryRun) tem.remove(tem.getReference(File, candidate.id));
          return candidate.fileName;
        });
        if (!fileName) continue;
        this.logger.debug(
          `${dryRun ? 'Would delete' : 'Deleted'} unreferenced File ${candidate.id} (${fileName})`,
        );
        if (!dryRun) await this.photos.deleteVariants(fileName);
        removed.set(candidate.id, fileName);
      } catch (error) {
        this.logger.warn(
          `Skipping unreferenced File ${candidate.id} (${candidate.fileName}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return removed;
  }

  private async findUnreferencedRows(
    em: EntityManager,
    cutoff: Date,
  ): Promise<Pick<File, 'id' | 'fileName'>[]> {
    const referenced: { photo: number }[] = await em
      .createQueryBuilder(Garment)
      .select('photo')
      .where({ photo: { $ne: null } })
      .execute();
    const referencedIds = referenced.map((row) => row.photo);
    // createdOn is an ISO string (src/web/files/photos.ts), so it orders as text.
    return em.find(
      File,
      {
        createdOn: { $lt: cutoff.toISOString() },
        ...(referencedIds.length ? { id: { $nin: referencedIds } } : {}),
      },
      { fields: ['fileName'] },
    );
  }

  private reportMissingOriginals(
    rows: Pick<File, 'fileName' | 'createdOn'>[],
    photoSets: Map<string, StoredPhotoSet>,
    cutoff: Date,
  ): number {
    const cutoffIso = cutoff.toISOString();
    let missing = 0;
    for (const row of rows) {
      if (row.createdOn >= cutoffIso) continue;
      if (photoSets.get(row.fileName)?.names.includes(row.fileName)) continue;
      this.logger.warn(
        `File row ${row.fileName} (created ${row.createdOn}) has no original in storage`,
      );
      missing += 1;
    }
    return missing;
  }
}
