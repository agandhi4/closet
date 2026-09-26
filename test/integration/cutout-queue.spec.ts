import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { retryFailedCutouts } from '../../src/cutout/queue';
import { file } from '../../src/db/schema';
import { alphaAt, fakeRunner, halfMask, storedCutout } from './cutouts';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import { createTestApp, multipart, type TestApp } from './harness';
import { silentLogger } from './logger';

/**
 * The background-removal queue (src/cutout/queue.ts) against the real
 * database, Photos and state machine, with the model replaced by a fake
 * runner: every job ends in exactly one allowed state, and no result lands
 * on a photo that was edited, replaced or changed while the job ran.
 */
describe('cutout queue', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(() => t?.cleanup());

  /** A garment with a 1200x800 photo (stored at 1080x720), queued by its upload. */
  async function queuedPhoto(name: string) {
    const garmentId = await createGarment(t, { name });
    await uploadPhoto(t, garmentId, await jpegPhoto(1200, 800));
    return { garmentId, fileName: await photoFileName(t, garmentId) };
  }

  it('makes the cutout from the mask: ready, new version, square with the background clear', async () => {
    const { garmentId, fileName } = await queuedPhoto('Queued shirt');
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 2,
      cutoutAttempts: 1,
      cutoutJobVersion: null,
    });
    const cutout = await storedCutout(t, fileName);
    expect(cutout).toBeDefined();
    const meta = await sharp(cutout).metadata();
    expect(meta).toMatchObject({
      format: 'webp',
      width: 1080,
      height: 1080,
      hasAlpha: true,
    });
    // The photo is centred (720 of 1080 high): the mask's garment half is
    // opaque, its background half and the padding transparent.
    expect(await alphaAt(cutout!, 800, 540)).toBeGreaterThan(250);
    expect(await alphaAt(cutout!, 200, 540)).toBeLessThan(5);
    expect(await alphaAt(cutout!, 800, 60)).toBe(0);

    // The thumb is rebuilt from the cutout and the pages show the new version.
    const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(grid.body).toContain(`/file/thumb/${fileName}?v=2`);
    const thumb = await t.inject({
      method: 'GET',
      url: `/file/thumb/${fileName}?v=2`,
    });
    expect((await sharp(thumb.rawPayload).metadata()).hasAlpha).toBe(true);

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Cutout ready: garment ${garmentId} photo \\d+ \\(${fileName.slice(0, 8)}\\), version 2; queue wait \\d+ ms, inference 7 ms, total \\d+ ms$`,
        ),
      ),
    );
  });

  it('marks a failed run failed, and a retry runs it again', async () => {
    const { fileName } = await queuedPhoto('Failing shirt');
    const runner = fakeRunner((call) => {
      if (call === 1) throw new Error('model exploded');
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'failed',
      version: 1,
      cutoutAttempts: 1,
    });
    expect(await storedCutout(t, fileName)).toBeUndefined();
    expect(t.logs.messages('error', 'Cutout')).toContainEqual(
      expect.stringMatching(/^Cutout failed: garment \d+ .*, attempt 1, after/),
    );

    await retryFailedCutouts(t.db, silentLogger);
    await t.cutouts.whenIdle();

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 2,
      cutoutAttempts: 2,
    });
  });

  it('discards a result for a photo version that changed meanwhile, then runs the new one', async () => {
    const { fileName } = await queuedPhoto('Changing shirt');
    const runner = fakeRunner(async (call) => {
      if (call === 1) {
        await t.db
          .update(file)
          .set({ version: sql`${file.version} + 1` })
          .where(eq(file.fileName, fileName));
      }
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(/^Cutout discarded \(stale\): /),
    );
    expect(runner.calls).toBe(2);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 3,
      cutoutAttempts: 2,
    });
  });

  it('never overwrites a cutout the user edited while the job ran', async () => {
    const { garmentId, fileName } = await queuedPhoto('Edited shirt');
    let edited: Buffer | undefined;
    const runner = fakeRunner(async () => {
      const body = await multipart(
        {},
        {
          nobgPhoto: {
            data: await pngCutout(),
            filename: 'cutout.png',
            contentType: 'image/png',
          },
        },
      );
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${garmentId}/nobg`,
        payload: body.payload,
        headers: body.headers,
      });
      expect(res.json()).toEqual({ version: 2 });
      edited = await storedCutout(t, fileName);
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(/^Cutout discarded \(not-allowed\): /),
    );
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'edited',
      version: 2,
    });
    expect(edited).toBeDefined();
    expect((await storedCutout(t, fileName))!.equals(edited!)).toBe(true);
  });

  it('writes nothing for a photo replaced while the job ran', async () => {
    const { garmentId, fileName } = await queuedPhoto('Replaced shirt');
    // Only the first job replaces the photo; the replacement is queued in
    // its own right and runs next.
    const runner = fakeRunner(async (call) => {
      if (call === 1) {
        await uploadPhoto(t, garmentId, await jpegPhoto(900, 900));
      }
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(/^Cutout discarded \(gone\): /),
    );
    expect(await photoRow(t, fileName)).toBeUndefined();
    expect(await storedCutout(t, fileName)).toBeUndefined();
    expect(runner.calls).toBe(2);
    expect(await photoRow(t, await photoFileName(t, garmentId))).toMatchObject({
      cutoutStatus: 'ready',
    });
  });

  it('resumes a job a restart interrupted', async () => {
    const garmentId = await createGarment(t, { name: 'Interrupted shirt' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
    // As a server killed mid-job leaves it: started, still pending.
    await t.db
      .update(file)
      .set({
        cutoutStatus: 'pending',
        cutoutAttempts: 1,
        cutoutJobVersion: 1,
        cutoutRequestedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(file.fileName, fileName));

    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
    });
  });

  it('leaves the job pending when the server stops mid-run', async () => {
    const { fileName } = await queuedPhoto('Shutdown shirt');
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let kill!: (error: Error) => void;
    const runner = fakeRunner(
      () =>
        new Promise<Buffer>((_resolve, reject) => {
          kill = reject;
          started();
        }),
    );
    runner.close = () => {
      kill(new Error('Model process exited (SIGTERM)'));
      return Promise.resolve();
    };

    t.cutouts.start(runner);
    await running;
    await t.cutouts.stop();

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 1,
    });
    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(/interrupted by shutdown: .*; stays pending$/),
    );
  });

  it('the nightly retry requeues failed cutouts under three attempts only', async () => {
    const retried = await queuedPhoto('Retried shirt');
    const exhausted = await queuedPhoto('Exhausted shirt');
    for (const [{ fileName }, attempts] of [
      [retried, 2],
      [exhausted, 3],
    ] as const) {
      await t.db
        .update(file)
        .set({ cutoutStatus: 'failed', cutoutAttempts: attempts })
        .where(eq(file.fileName, fileName));
    }

    await expect(retryFailedCutouts(t.db, silentLogger)).resolves.toBe(1);

    expect(await photoRow(t, retried.fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 2,
    });
    expect(await photoRow(t, exhausted.fileName)).toMatchObject({
      cutoutStatus: 'failed',
      cutoutAttempts: 3,
    });
  });
});
