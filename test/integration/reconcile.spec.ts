import { randomUUID } from 'node:crypto';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { file } from '../../src/db/schema';
import {
  reconcileStorage,
  type ReconcileOptions,
  type ReconciliationReport,
} from '../../src/maintenance/reconcile';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  photoRowCount,
  uploadPhoto,
} from './garments';
import { createTestApp, TestApp } from './harness';
import { silentLogger } from './logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The three reconciliation passes against the real app: storage without
 * rows, rows without garments, rows without storage. The deletion guard
 * has its own spec (reconcile-guard.spec.ts).
 */
describe('storage reconciliation', () => {
  let t: TestApp;
  const reconcile = (options?: ReconcileOptions) =>
    reconcileStorage(
      { db: t.db, photos: t.photos, logger: silentLogger },
      options,
    );

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();

  const writeAged = async (name: string, ageMs: number) => {
    const path = join(t.dataPath, name);
    await writeFile(path, `bytes of ${name}`);
    const then = new Date(Date.now() - ageMs);
    await utimes(path, then, then);
  };

  const ageRow = async (fileName: string, ageMs: number) => {
    await t.db
      .update(file)
      .set({ createdOn: new Date(Date.now() - ageMs).toISOString() })
      .where(eq(file.fileName, fileName));
  };

  const orphanRow = async (ageMs: number) => {
    const fileName = `${randomUUID()}.webp`;
    await t.db.insert(file).values({
      fileName,
      shareableId: randomUUID(),
      createdOn: new Date(Date.now() - ageMs).toISOString(),
      createdById: t.owner.id,
    });
    return fileName;
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('deletes stale orphans only, reports lost originals, and a dry run changes nothing', async () => {
    // A live photo: row referenced by a garment, bytes present. Untouchable.
    const liveGarment = await createGarment(t, { name: 'Live' });
    await uploadPhoto(t, liveGarment, await jpegPhoto());
    const live = await photoFileName(t, liveGarment);
    await ageRow(live, 3 * DAY_MS);

    // A referenced row whose original vanished from disk: reported, kept.
    const lostGarment = await createGarment(t, { name: 'Lost' });
    await uploadPhoto(t, lostGarment, await jpegPhoto(300, 300));
    const lost = await photoFileName(t, lostGarment);
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
    const rowsBefore = await photoRowCount(t);
    // Files only: DATA_PATH/.incoming (in-flight writes) is not an object.
    const objectsBefore = (
      await readdir(t.dataPath, { withFileTypes: true })
    ).filter((entry) => entry.isFile()).length;
    const expected: Omit<ReconciliationReport, 'durationMs' | 'dryRun'> = {
      storedObjects: objectsBefore,
      // live, lost (its thumb), staleOrphan, recentOrphan, staleRow
      storedPhotoSets: 5,
      orphanedObjectsDeleted: 1,
      orphanedRowsDeleted: 1,
      missingOriginals: 1,
    };

    const dryRun = await reconcile({ dryRun: true });
    expect(dryRun).toMatchObject({ ...expected, dryRun: true });
    expect(dryRun.refused).toBeUndefined();
    expect(await storedFiles()).toEqual(filesBefore);
    expect(await photoRowCount(t)).toBe(rowsBefore);

    const report = await reconcile();
    expect(report).toMatchObject({ ...expected, dryRun: false });
    expect(report.refused).toBeUndefined();

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

    expect(await photoRow(t, live)).toBeDefined();
    expect(await photoRow(t, lost)).toBeDefined();
    expect(await photoRow(t, recentRow)).toBeDefined();
    expect(await photoRow(t, staleRow)).toBeUndefined();
    expect(await photoRowCount(t)).toBe(rowsBefore - 1);

    // A second pass finds nothing new to delete.
    const again = await reconcile();
    expect(again).toMatchObject({
      orphanedObjectsDeleted: 0,
      orphanedRowsDeleted: 0,
      missingOriginals: 1,
    });
  });
});
