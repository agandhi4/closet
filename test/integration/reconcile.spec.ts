import { randomUUID } from 'node:crypto';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { File } from '../../src/dal/entity/file.entity';
import { Garment } from '../../src/dal/entity/garment.entity';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  ReconciliationReport,
  StorageReconciliationService,
} from '../../src/maintenance/storage-reconciliation.service';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, TestApp } from './harness';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The three reconciliation passes against the real app: storage without
 * rows, rows without garments, rows without storage. Runs on Postgres too
 * when TEST_DATABASE_URL is set (the row queries differ per driver).
 */
describe('storage reconciliation', () => {
  let t: TestApp;
  let service: StorageReconciliationService;

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();

  const writeAged = async (name: string, ageMs: number) => {
    const path = join(t.dataPath, name);
    await writeFile(path, `bytes of ${name}`);
    const then = new Date(Date.now() - ageMs);
    await utimes(path, then, then);
  };

  const photoFileName = async (garmentId: number) =>
    (await t.em().findOneOrFail(Garment, garmentId, { populate: ['photo'] }))
      .photo!.fileName;

  const ageRow = async (fileName: string, ageMs: number) => {
    const em = t.em();
    const row = await em.findOneOrFail(File, { fileName });
    row.createdOn = new Date(Date.now() - ageMs).toISOString();
    await em.flush();
  };

  const orphanRow = async (ageMs: number) => {
    const fileName = `${randomUUID()}.webp`;
    const em = t.em();
    em.create(File, {
      fileName,
      createdOn: new Date(Date.now() - ageMs).toISOString(),
      createdBy: t.owner.id,
    });
    await em.flush();
    return fileName;
  };

  beforeAll(async () => {
    t = await createTestApp();
    service = t.app.get(StorageReconciliationService);
  });

  afterAll(() => t?.cleanup());

  it('deletes stale orphans only, reports lost originals, and a dry run changes nothing', async () => {
    // A live photo: row referenced by a garment, bytes present. Untouchable.
    const liveGarment = await createGarment(t, { name: 'Live' });
    await uploadPhoto(t, liveGarment, await jpegPhoto());
    const live = await photoFileName(liveGarment);
    await ageRow(live, 3 * DAY_MS);

    // A referenced row whose original vanished from disk: reported, kept.
    const lostGarment = await createGarment(t, { name: 'Lost' });
    await uploadPhoto(t, lostGarment, await jpegPhoto(300, 300));
    const lost = await photoFileName(lostGarment);
    await ageRow(lost, 3 * DAY_MS);
    await rm(join(t.dataPath, lost));

    // Storage without rows: a two-day-old full set and a fresh original.
    const staleOrphan = `${randomUUID()}.webp`;
    for (const variant of ['original', 'nobg', 'thumb'] as const) {
      await writeAged(variantFileName(staleOrphan, variant), 2 * DAY_MS);
    }
    const recentOrphan = `${randomUUID()}.webp`;
    await writeAged(recentOrphan, 0);

    // Rows without garments: one old (with bytes), one from just now.
    const staleRow = await orphanRow(2 * DAY_MS);
    await writeAged(staleRow, 2 * DAY_MS);
    await writeAged(variantFileName(staleRow, 'thumb'), 2 * DAY_MS);
    const recentRow = await orphanRow(0);

    // Not a photo: whatever else lives under DATA_PATH stays.
    await writeAged('notes.txt', 5 * DAY_MS);

    const filesBefore = await storedFiles();
    const rowsBefore = await t.em().count(File);
    // Files only: DATA_PATH/.incoming (in-flight writes) is not an object.
    const objectsBefore = (
      await readdir(t.dataPath, { withFileTypes: true })
    ).filter((entry) => entry.isFile()).length;
    const expected: Omit<ReconciliationReport, 'durationMs' | 'dryRun'> = {
      storedObjects: objectsBefore,
      orphanedObjectsDeleted: 1,
      orphanedRowsDeleted: 1,
      missingOriginals: 1,
    };

    const dryRun = await service.reconcile({ dryRun: true });
    expect(dryRun).toMatchObject({ ...expected, dryRun: true });
    expect(await storedFiles()).toEqual(filesBefore);
    expect(await t.em().count(File)).toBe(rowsBefore);

    const report = await service.reconcile();
    expect(report).toMatchObject({ ...expected, dryRun: false });

    const files = await storedFiles();
    expect(files).toContain(live);
    expect(files).toContain(variantFileName(live, 'thumb'));
    expect(files).toContain(variantFileName(lost, 'thumb'));
    expect(files).toContain(recentOrphan);
    for (const variant of ['original', 'nobg', 'thumb'] as const) {
      expect(files).not.toContain(variantFileName(staleOrphan, variant));
    }
    expect(files).not.toContain(staleRow);
    expect(files).not.toContain(variantFileName(staleRow, 'thumb'));
    expect(await readdir(t.dataPath)).toContain('notes.txt');

    const em = t.em();
    expect(await em.findOne(File, { fileName: live })).not.toBeNull();
    expect(await em.findOne(File, { fileName: lost })).not.toBeNull();
    expect(await em.findOne(File, { fileName: recentRow })).not.toBeNull();
    expect(await em.findOne(File, { fileName: staleRow })).toBeNull();
    expect(await em.count(File)).toBe(rowsBefore - 1);

    // A second pass finds nothing new to delete.
    const again = await service.reconcile();
    expect(again).toMatchObject({
      orphanedObjectsDeleted: 0,
      orphanedRowsDeleted: 0,
      missingOriginals: 1,
    });
  });
});
