import { randomUUID } from 'node:crypto';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { file, garment } from '../../src/db/schema';
import {
  GUARD_MAX_SETS,
  reconcileStorage,
  type ReconcileOptions,
} from '../../src/maintenance/reconcile';
import { variantFileName } from '../../src/web/files/image-variant';
import { photoRowCount } from './garments';
import { createTestApp, TestApp } from './harness';
import { silentLogger } from './logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const TWO_DAYS_AGO = () => new Date(Date.now() - 2 * DAY_MS);

/**
 * The deletion guard: reconciliation deletes photo sets whose rows are
 * gone, so a database that lost its rows (a restore, the wrong DATABASE_*)
 * would have it wipe the photos. It refuses when the file table is empty
 * while storage holds photos, and when one run would delete more than
 * GUARD_MAX_SETS sets or more than a fifth of them; `force` overrides.
 * Stores are built straight on disk and in the tables: the guard is about
 * counts, and hundreds of uploads through the app would only be slow.
 */
describe('storage reconciliation guard', () => {
  let t: TestApp;

  const reconcile = (options?: ReconcileOptions) =>
    reconcileStorage(
      { db: t.db, photos: t.photos, logger: silentLogger },
      options,
    );

  const storedPhotos = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  /** An original and its thumb, two days old, with no row. */
  const writeSet = async (): Promise<string> => {
    const fileName = `${randomUUID()}.webp`;
    for (const variant of ['original', 'thumb'] as const) {
      const path = join(t.dataPath, variantFileName(fileName, variant));
      await writeFile(path, 'bytes');
      await utimes(path, TWO_DAYS_AGO(), TWO_DAYS_AGO());
    }
    return fileName;
  };

  const orphans = async (count: number) => {
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(await writeSet());
    return names;
  };

  /** Photo sets a garment points at: what a healthy store is made of. */
  const livePhotos = async (count: number) => {
    const names = await orphans(count);
    const rows = await t.db
      .insert(file)
      .values(
        names.map((fileName) => ({
          fileName,
          shareableId: randomUUID(),
          createdOn: TWO_DAYS_AGO().toISOString(),
          createdById: t.owner.id,
        })),
      )
      .returning({ id: file.id });
    await t.db.insert(garment).values(
      rows.map(({ id }) => ({
        shareableId: randomUUID(),
        category: 'shirt',
        ownerId: t.owner.id,
        photoId: id,
      })),
    );
    return names;
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await t.db.delete(garment);
    await t.db.delete(file);
    for (const name of await storedPhotos()) {
      await rm(join(t.dataPath, name));
    }
  });

  afterAll(() => t?.cleanup());

  it('refuses while the file table is empty and storage holds photos', async () => {
    await orphans(2);
    const before = await storedPhotos();

    const dryRun = await reconcile({ dryRun: true });
    expect(dryRun.refused).toMatch(/file table is empty/);
    const report = await reconcile();
    expect(report).toMatchObject({
      storedPhotoSets: 2,
      orphanedObjectsDeleted: 0,
      orphanedRowsDeleted: 0,
    });
    expect(report.refused).toMatch(/file table is empty/);
    expect(await storedPhotos()).toEqual(before);
  });

  it(`refuses more than ${GUARD_MAX_SETS} sets in one run, even as a small fraction`, async () => {
    // 26 of 130 is exactly a fifth: only the absolute cap applies.
    await livePhotos(104);
    await orphans(GUARD_MAX_SETS + 1);
    const before = await storedPhotos();

    const report = await reconcile();
    expect(report.storedPhotoSets).toBe(130);
    expect(report.refused).toMatch(/26 photo sets would go, more than 25/);
    expect(report.orphanedObjectsDeleted).toBe(0);
    expect(await storedPhotos()).toEqual(before);
  });

  it('refuses more than a fifth of the stored sets', async () => {
    await livePhotos(20);
    await orphans(6);
    const before = await storedPhotos();

    const report = await reconcile();
    expect(report.refused).toMatch(/6 of 26 stored photo sets.*more than 20%/);
    expect(await storedPhotos()).toEqual(before);
  });

  it('counts rows no garment references as deletions too', async () => {
    const live = await livePhotos(20);
    // Six rows lose their garments: the rows and their bytes would go.
    const unreferenced = live.slice(0, 6);
    await t.db
      .delete(garment)
      .where(
        inArray(
          garment.photoId,
          t.db
            .select({ id: file.id })
            .from(file)
            .where(inArray(file.fileName, unreferenced)),
        ),
      );

    const report = await reconcile();
    expect(report.refused).toMatch(/6 of 20 stored photo sets/);
    expect(report.orphanedRowsDeleted).toBe(0);
    expect(await photoRowCount(t)).toBe(20);
  });

  it('still cleans a young store: a handful of sets is never refused for its fraction', async () => {
    await livePhotos(2);
    const stray = await orphans(3);

    const report = await reconcile();
    expect(report.refused).toBeUndefined();
    expect(report.orphanedObjectsDeleted).toBe(3);
    const left = await storedPhotos();
    for (const name of stray) expect(left).not.toContain(name);
    expect(left).toHaveLength(4);
  });

  it('force deletes what the guard refused', async () => {
    await livePhotos(20);
    const stray = await orphans(6);

    const report = await reconcile({ force: true });
    expect(report.refused).toBeUndefined();
    expect(report.orphanedObjectsDeleted).toBe(6);
    const left = await storedPhotos();
    for (const name of stray) expect(left).not.toContain(name);
    expect(await photoRowCount(t)).toBe(20);
  });
});
