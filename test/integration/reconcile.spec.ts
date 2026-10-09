import { randomUUID } from 'node:crypto';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { file, selfie } from '../../src/db/schema';
import {
  reconcileStorage,
  type ReconcileOptions,
  type ReconciliationReport,
} from '../../src/maintenance/reconcile';
import { addDays } from '../../src/calendar-date';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  photoRowCount,
  pngCutout,
  uploadPhoto,
} from './garments';
import { createTestApp, TestApp } from './harness';
import { silentLogger } from './logger';
import { planEntry, takeSelfie } from './selfies';

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
      // Link imports have their own pass (link-import.spec.ts).
      pendingPhotosDeleted: 0,
      pendingRowsWithoutFiles: 0,
      supersededVariantsDeleted: 0,
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

  // #141: a cutout is stored under a variant key before its row points at
  // it, so a write that died before its swap (or whose clean-up failed)
  // leaves files the base name alone cannot tell from the live ones.
  /** A garment photo with a mask edit: its row keyed, its set aged `ageMs`. */
  const keyedPhoto = async (name: string, ageMs: number) => {
    const garmentId = await createGarment(t, { name });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
    await ageRow(fileName, 5 * DAY_MS);
    await t.photos.saveEditedCutout(Readable.from(await pngCutout()), fileName);
    const { variantKey } = (await photoRow(t, fileName))!;
    const current = variantSet(fileName, variantKey);
    const then = new Date(Date.now() - ageMs);
    for (const name of current) {
      await utimes(join(t.dataPath, name), then, then);
    }
    return { fileName, variantKey, current };
  };

  const variantSet = (fileName: string, key: string | null) =>
    (['nobg', 'thumb'] as const).map((variant) =>
      variantFileName(fileName, variant, key),
    );

  const reconcileLogged = (options?: ReconcileOptions) =>
    reconcileStorage({ db: t.db, photos: t.photos, logger: t.logger }, options);

  it("deletes a live photo's day-old variants under another key than its row's", async () => {
    // Old as they are, the row's own files stay.
    const { fileName, current } = await keyedPhoto('Recut', 2 * DAY_MS);
    // Older than the row's set: a write that died before an earlier swap.
    const died = variantSet(fileName, '0123456789ab');
    for (const name of died) await writeAged(name, 3 * DAY_MS);
    // A thumb backfilled for a request that raced the swap.
    const unkeyedThumb = variantFileName(fileName, 'thumb');
    await writeAged(unkeyedThumb, 3 * DAY_MS);
    // A write between its files and its swap right now.
    const inFlight = variantFileName(fileName, 'nobg', 'abcdefabcdef');
    await writeAged(inFlight, 0);

    const dryRun = await reconcile({ dryRun: true });
    expect(dryRun.supersededVariantsDeleted).toBe(3);
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([...died, unkeyedThumb]),
    );

    const report = await reconcile();
    expect(report.refused).toBeUndefined();
    expect(report.supersededVariantsDeleted).toBe(3);
    const files = await storedFiles();
    expect(files).toEqual(
      expect.arrayContaining([fileName, ...current, inFlight]),
    );
    for (const name of [...died, unkeyedThumb]) {
      expect(files).not.toContain(name);
    }
    expect((await reconcile()).supersededVariantsDeleted).toBe(0);
  });

  // A database restored from a backup taken before an edit: the row names
  // the older key, and the newer set is the photo's real cutout. Deleting
  // it would lose the only copy; before #141 a restore never deleted bytes.
  it("keeps a set newer than the row's, warning of a restore behind storage", async () => {
    const { fileName, variantKey, current } = await keyedPhoto(
      'Restored',
      4 * DAY_MS,
    );
    const newer = variantSet(fileName, 'fedcba987654');
    for (const name of newer) await writeAged(name, 2 * DAY_MS);
    t.logs.clear();

    const report = await reconcileLogged();

    expect(report.supersededVariantsDeleted).toBe(0);
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([...current, ...newer]),
    );
    expect(t.logs.messages('warn')).toContainEqual(
      `Keeping variant key fedcba987654 of ${fileName}: newer than the row's variant (key ${variantKey}): database restored behind storage?`,
    );
  });

  // A thumb backfilled across a swap: a request that resolved the old key
  // regenerates its thumb after the swap deleted it. Derived, never the one
  // copy of anything, so no restore warning keeps it.
  it("deletes a lone superseded thumb newer than the row's set, without a restore warning", async () => {
    const { fileName, current } = await keyedPhoto('Backfilled', 4 * DAY_MS);
    const loneThumb = variantFileName(fileName, 'thumb', 'aaaaaaaaaaaa');
    await writeAged(loneThumb, 2 * DAY_MS);
    t.logs.clear();

    const report = await reconcileLogged();

    expect(report.supersededVariantsDeleted).toBe(1);
    const files = await storedFiles();
    expect(files).not.toContain(loneThumb);
    expect(files).toEqual(expect.arrayContaining(current));
    expect(
      t.logs.messages('warn').filter((message) => message.includes(fileName)),
    ).toEqual([]);
  });

  it("keeps a lone superseded cutout newer than the row's set, with the warning", async () => {
    const { fileName, variantKey } = await keyedPhoto('Lone cut', 4 * DAY_MS);
    const loneNobg = variantFileName(fileName, 'nobg', 'bbbbbbbbbbbb');
    await writeAged(loneNobg, 2 * DAY_MS);
    t.logs.clear();

    await reconcileLogged();

    expect(await storedFiles()).toContain(loneNobg);
    expect(t.logs.messages('warn')).toContainEqual(
      `Keeping variant key bbbbbbbbbbbb of ${fileName}: newer than the row's variant (key ${variantKey}): database restored behind storage?`,
    );
  });

  it("deletes nothing of a photo whose row's own set is missing", async () => {
    const { fileName, variantKey, current } = await keyedPhoto(
      'Lost cut',
      2 * DAY_MS,
    );
    for (const name of current) await rm(join(t.dataPath, name));
    const older = variantSet(fileName, '0123456789ab');
    for (const name of older) await writeAged(name, 3 * DAY_MS);
    t.logs.clear();

    const report = await reconcileLogged();

    expect(report.supersededVariantsDeleted).toBe(0);
    expect(await storedFiles()).toEqual(expect.arrayContaining(older));
    expect(t.logs.messages('warn')).toContainEqual(
      `Keeping every variant of ${fileName}: the files of its row's variant (key ${variantKey}) are not in storage`,
    );
  });
});

/**
 * Outfit selfies (#19) are photos no garment points at: before
 * photoIsReferenced counted them, every one was an unreferenced `file` row
 * and the night after it was taken reconciliation deleted it, row and
 * bytes. An entry's selfie and a look kept after its outfit was deleted
 * (no entry any more) must both survive, a day old and older, beside a
 * real orphan the same run deletes.
 */
describe('storage reconciliation and outfit selfies', () => {
  let t: TestApp;

  const age = async (fileName: string, ageMs: number) => {
    const then = new Date(Date.now() - ageMs);
    await t.db
      .update(file)
      .set({ createdOn: then.toISOString() })
      .where(eq(file.fileName, fileName));
    const stored = await readdir(t.dataPath);
    for (const variant of ['original', 'nobg', 'thumb'] as const) {
      const name = variantFileName(fileName, variant);
      if (stored.includes(name))
        await utimes(join(t.dataPath, name), then, then);
    }
  };

  /** An outfit planned on `day` with a selfie taken; its ids and photo. */
  const selfieOn = async (name: string, day: string) => {
    const garmentId = await createGarment(t, { name: `${name} shirt` });
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: { name, category: 'shirt', garmentId: String(garmentId) },
    });
    const outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(res.headers.location as string)![1],
    );
    const entryId = await planEntry(t, outfitId, day);
    return { outfitId, ...(await takeSelfie(t, entryId)) };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('never deletes a selfie as an orphan, an entry’s or a look kept after its outfit', async () => {
    const day = addDays(t.today(), -3);
    const entrySelfie = await selfieOn('Date night', day);
    const kept = await selfieOn('Deleted later', day);
    const deleted = await t.inject({
      method: 'DELETE',
      url: `/outfits/${kept.outfitId}`,
      headers: { 'hx-request': 'true' },
    });
    expect(deleted.statusCode).toBe(200);
    const [look] = await t.db
      .select({ entry: selfie.outfitCalendarId })
      .from(selfie)
      .where(eq(selfie.id, kept.id));
    expect(look.entry).toBeNull();

    // A real orphan: a `file` row nothing references, with its bytes.
    const orphan = `${randomUUID()}.webp`;
    await t.db.insert(file).values({
      fileName: orphan,
      shareableId: randomUUID(),
      createdOn: new Date().toISOString(),
      createdById: t.owner.id,
    });
    await writeFile(join(t.dataPath, orphan), 'bytes of an orphan');
    for (const name of [entrySelfie.fileName, kept.fileName, orphan]) {
      await age(name, 3 * DAY_MS);
    }

    const report = await reconcileStorage({
      db: t.db,
      photos: t.photos,
      logger: silentLogger,
    });

    expect(report.refused).toBeUndefined();
    expect(report).toMatchObject({
      orphanedRowsDeleted: 1,
      orphanedObjectsDeleted: 0,
      missingOriginals: 0,
    });
    const files = await readdir(t.dataPath);
    for (const { fileName } of [entrySelfie, kept]) {
      expect(await photoRow(t, fileName)).toBeDefined();
      expect(files).toContain(fileName);
      expect(files).toContain(variantFileName(fileName, 'thumb'));
    }
    expect(
      await t.db.$count(selfie, inArray(selfie.id, [entrySelfie.id, kept.id])),
    ).toBe(2);
    expect(await photoRow(t, orphan)).toBeUndefined();
    expect(files).not.toContain(orphan);
  });
});
