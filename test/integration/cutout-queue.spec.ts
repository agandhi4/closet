import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { settlesWithin } from '../../src/cutout/deadline';
import { CUTOUT_LEASE_MS } from '../../src/cutout/queries';
import { retryFailedCutouts } from '../../src/cutout/queue';
import { file } from '../../src/db/schema';
import {
  alphaAt,
  eventually,
  fakeRunner,
  halfMask,
  storedCutout,
} from './cutouts';
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
 * on a photo that was edited, replaced or changed while the job ran. A job
 * leases its row while it runs (#45) and every ending clears the lease.
 */

/** The lease columns of a row no job holds. */
const NO_LEASE = { cutoutWorker: null, cutoutStartedAt: null };
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
      ...NO_LEASE,
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
      ...NO_LEASE,
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
      // The row stays pending for the new version: its lease is given back
      // at once, rather than left to lapse.
      expect.stringMatching(/^Cutout discarded \(stale\): .*; lease released$/),
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
      ...NO_LEASE,
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

  it('leases the row while the job runs, and releases it when the server stops mid-run', async () => {
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
    const leased = await photoRow(t, fileName);
    expect(leased).toMatchObject({
      cutoutStatus: 'pending',
      cutoutJobVersion: 1,
    });
    expect(leased!.cutoutWorker).toMatch(/^.+:\d+:[0-9a-f]{8}$/);
    expect(leased!.cutoutStartedAt).toBeInstanceOf(Date);
    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringContaining(`started as worker ${leased!.cutoutWorker};`),
    );

    await t.cutouts.stop();

    // Released rather than left to lapse: the job has ended here, so the
    // next server runs the photo at once instead of in five minutes.
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 1,
      cutoutJobVersion: null,
      ...NO_LEASE,
    });
    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(
        /interrupted by shutdown: .*; stays pending, lease released$/,
      ),
    );

    const next = fakeRunner();
    t.cutouts.start(next);
    await t.cutouts.whenIdle();
    expect(next.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
      ...NO_LEASE,
    });
  });

  /** A pending row as another server's job leaves it: started, leased `ageMs` ago. */
  async function leasedElsewhere(fileName: string, ageMs: number) {
    await t.db
      .update(file)
      .set({
        cutoutAttempts: 1,
        cutoutJobVersion: 1,
        cutoutWorker: 'other-box:1:0badf00d',
        cutoutStartedAt: sql`now() - make_interval(secs => ${ageMs / 1000})`,
      })
      .where(eq(file.fileName, fileName));
  }

  it("never runs a photo another server's live job holds", async () => {
    const { fileName } = await queuedPhoto('Leased shirt');
    await leasedElsewhere(fileName, CUTOUT_LEASE_MS - 60_000);
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(0);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 1,
      cutoutWorker: 'other-box:1:0badf00d',
    });
    // The other server "crashes": later tests find nothing left pending.
    await leasedElsewhere(fileName, CUTOUT_LEASE_MS + 1_000);
    await t.cutouts.whenIdle();
    expect(runner.calls).toBe(1);
  });

  it('never claims or leases an unwanted photo (an outfit selfie)', async () => {
    const { fileName } = await queuedPhoto('Selfie-like shirt');
    await t.db
      .update(file)
      .set({ cutoutStatus: 'unwanted', cutoutRequestedAt: null })
      .where(eq(file.fileName, fileName));
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(0);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'unwanted',
      cutoutAttempts: 0,
      ...NO_LEASE,
    });
  });

  it("runs a crashed server's job once its lease has lapsed", async () => {
    const { fileName } = await queuedPhoto('Orphaned shirt');
    await leasedElsewhere(fileName, CUTOUT_LEASE_MS + 1_000);
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
      ...NO_LEASE,
    });
    expect(t.logs.messages('warn', 'Cutout')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Cutout lease of worker other-box:1:0badf00d lapsed after 5 min; running garment \\d+ photo \\d+ \\(${fileName.slice(0, 8)}\\) again$`,
        ),
      ),
    );
  });

  it('ignores "Try again" on a photo whose job is running, and keeps its result', async () => {
    const { garmentId, fileName } = await queuedPhoto('Impatient shirt');
    const runner = fakeRunner(async () => {
      const retry = await t.inject({
        method: 'POST',
        url: `/wardrobe/${garmentId}/cutout/retry`,
      });
      expect(retry.statusCode).toBe(303);
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 2,
      cutoutAttempts: 1,
      ...NO_LEASE,
    });
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${garmentId} cutout retry ignored (not-allowed)`,
    );
  });

  it('claims nothing while the runner cannot ready its model, and still stops promptly', async () => {
    const { fileName } = await queuedPhoto('Modelless shirt');
    const runner = fakeRunner();
    runner.ready = () => Promise.reject(new Error('Model download failed'));

    t.cutouts.start(runner);
    await eventually('the queue to give up on the model', () =>
      Promise.resolve(
        t.logs
          .messages('warn', 'Cutout')
          .includes(
            'Cutout queue cannot run the model (Model download failed); pending cutouts wait, trying again in 5 min',
          ),
      ),
    );
    // Its five-minute wait ends with the queue.
    expect(await settlesWithin(t.cutouts.stop(), 2_000)).toBe(true);

    expect(runner.calls).toBe(0);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 0,
      ...NO_LEASE,
    });
    // With the model back, the photo runs.
    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
    });
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
