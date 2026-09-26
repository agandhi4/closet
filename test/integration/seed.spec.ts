import { asc, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  file,
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
  user,
  wardrobeShare,
} from '../../src/db/schema';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import { variantFileName } from '../../src/web/files/image-variant';
import { loadPersona } from '../../src/seed/persona';
import { runSeed, seedPersona } from '../../src/seed/seed';
import { countToTag } from '../../src/web/wardrobe/queries';
import {
  createTestApp,
  extractImgSrcs,
  OWNER_EMAIL,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';

/**
 * `npm run seed`, run as the CLI runs it (runSeed) against the real app's
 * database and storage: the personas are written through the app's own
 * writers, so the pages show them, and seeding is idempotent, rebuildable
 * and removable without leftovers.
 */
describe('seed personas', () => {
  let t: TestApp;
  const PASSWORD = 'Closet-demo-1';
  const ANCHOR = '2026-09-26';
  const EMAILS = ['demo', 'fresh', 'sparse'].map((p) => `${p}@closet.invalid`);

  const run = async (args: string[], stdin = `${PASSWORD}\n`) => {
    const output = new PassThrough();
    const errors = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    errors.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const status = await runSeed({
      args,
      db: t.db,
      photos: t.photos,
      logger: t.logger,
      timeZone: 'America/New_York',
      input: Readable.from([stdin]),
      output,
      errors,
      now: new Date('2026-09-26T16:00:00Z'),
    });
    return { status, stdout, stderr };
  };

  const seedAll = (...extra: string[]) =>
    run(['--persona', 'all', '--anchor', ANCHOR, '--password-stdin', ...extra]);

  const personaIds = async () =>
    (
      await t.db
        .select({ id: user.id })
        .from(user)
        .where(inArray(user.email, EMAILS))
    ).map((row) => row.id);

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();

  const sha = async (name: string) =>
    createHash('sha256')
      .update(await readFile(join(t.dataPath, name)))
      .digest('hex');

  // Differ between runs by design: ids, UUIDs, the photo row's id.
  const VARYING = ['id', 'shareableId', 'photoId', 'ownerId'] as const;

  /**
   * What a persona is, without what differs between runs by design (row
   * ids, UUIDs, file names): every garment field and its cutout's bytes,
   * outfits with their slots, the calendar, shares.
   */
  const snapshot = async (email: string) => {
    const id = await userIdOf(t, email);
    const garments = await t.db
      .select({ garment, fileName: file.fileName, cutout: file.cutoutStatus })
      .from(garment)
      .leftJoin(file, eq(file.id, garment.photoId))
      .where(eq(garment.ownerId, id))
      .orderBy(asc(garment.id));
    const ids = new Map(garments.map((g) => [g.garment.id, g.garment.name]));
    const outfits = await t.db.query.outfit.findMany({
      where: eq(outfit.ownerId, id),
      orderBy: asc(outfit.id),
      with: { slots: { orderBy: asc(outfitSlot.position) } },
    });
    const names = new Map(outfits.map((o) => [o.id, o.name]));
    const calendar = await t.db
      .select()
      .from(outfitCalendar)
      .where(eq(outfitCalendar.ownerId, id))
      .orderBy(asc(outfitCalendar.day), asc(outfitCalendar.id));
    const shares = await t.db
      .select({
        grantee: wardrobeShare.granteeId,
        permission: wardrobeShare.permission,
      })
      .from(wardrobeShare)
      .where(eq(wardrobeShare.grantorId, id));
    return {
      garments: await Promise.all(
        garments.map(async ({ garment: g, fileName, cutout }) => {
          const fields: Partial<typeof g> = { ...g };
          for (const key of VARYING) delete fields[key];
          return {
            ...fields,
            cutout,
            nobg: fileName && (await sha(variantFileName(fileName, 'nobg'))),
          };
        }),
      ),
      outfits: outfits.map((o) => ({
        name: o.name,
        slots: o.slots.map((s) => [
          s.category,
          s.garmentId && ids.get(s.garmentId),
        ]),
      })),
      calendar: calendar.map((c) => ({
        day: c.day,
        outfit: names.get(c.outfitId),
        wornAt: c.wornAt?.toISOString() ?? null,
      })),
      shares: shares.length,
    };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('seeds every persona through the app, prints the logins once, and a second run changes nothing', async () => {
    const first = await seedAll();
    expect(first).toMatchObject({ status: 0, stderr: '' });
    expect(first.stdout).toContain(
      'demo: seeded 83 garments, 83 photos, 26 outfits',
    );
    expect(first.stdout).toContain(
      `Sign in as demo@closet.invalid with ${PASSWORD}`,
    );
    expect(first.stdout).toContain(
      'sparse: seeded 12 garments, 8 photos, 1 outfits',
    );
    expect(first.stdout).toContain('fresh: seeded 0 garments');

    const demo = await snapshot(EMAILS[0]);
    expect(demo.garments.filter((g) => g.archived)).toHaveLength(3);
    // The art is its own cutout: nothing waits in the background-removal queue.
    expect(new Set(demo.garments.map((g) => g.cutout))).toEqual(
      new Set(['ready']),
    );
    const jeans = demo.garments.find((g) => g.name === 'Raw selvedge jeans')!;
    expect(jeans).toMatchObject({
      brand: 'The Unbranded Brand',
      type: 'jeans',
      warmth: 4,
      fabricWeight: 492,
      price: '112.00',
      acquiredOn: '2026-05-02',
      sourceUrl: expect.stringMatching(/^https:\/\/theunbrandedbrand\.com\//),
    });
    const worn = demo.calendar.filter((entry) => entry.wornAt);
    expect(worn.length).toBeGreaterThan(60);
    // Worn that evening in New York; the planned week after the anchor is not.
    expect(worn.find((entry) => entry.day === '2026-08-29')).toEqual({
      day: '2026-08-29',
      outfit: 'Wedding',
      wornAt: '2026-08-30T01:00:00.000Z',
    });
    expect(
      demo.calendar
        .filter((entry) => entry.day > ANCHOR)
        .every((entry) => entry.wornAt === null),
    ).toBe(true);
    // Fully tagged but for the socks, which no type fits.
    expect(await countToTag(t.db, await userIdOf(t, EMAILS[0]))).toBe(1);
    // Dana's wardrobe is shared with Theo, MANAGE.
    expect((await snapshot(EMAILS[2])).shares).toBe(1);

    const files = await storedFiles();
    const again = await seedAll();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('demo: already seeded');
    expect(again.stdout).not.toContain(PASSWORD);
    expect(await storedFiles()).toEqual(files);
    expect(await snapshot(EMAILS[0])).toEqual(demo);
  });

  it('shows the seeded wardrobe, outfits and calendar on the app pages', async () => {
    const cookie = await t.login(EMAILS[0], PASSWORD);
    const grid = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie },
    });
    expect(grid.statusCode).toBe(200);
    expect(grid.body).toContain('Olive chore coat');
    const thumb = extractImgSrcs(unescapeHtml(grid.body)).find((src) =>
      src.startsWith('/file/'),
    )!;
    const image = await t.inject({
      method: 'GET',
      url: thumb,
      headers: { cookie },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');

    const week = await t.inject({
      method: 'GET',
      url: '/calendar?week=2026-08-23',
      headers: { cookie },
    });
    expect(week.body).toContain('Wedding');

    // Theo manages his sister's wardrobe through her share: tagging included.
    const sparseId = await userIdOf(t, EMAILS[2]);
    const tag = await t.inject({
      method: 'GET',
      url: `/wardrobe/tag?ownerId=${sparseId}`,
      headers: { cookie },
    });
    expect(tag.statusCode).toBe(200);
  });

  it('--reset rebuilds the same persona', async () => {
    const before = await snapshot(EMAILS[0]);
    const reset = await run([
      '--persona',
      'demo',
      '--reset',
      '--anchor',
      ANCHOR,
      '--password-stdin',
    ]);
    expect(reset.status).toBe(0);
    expect(reset.stdout).toContain('demo: removed');
    expect(reset.stdout).toContain('demo: seeded');
    expect(await snapshot(EMAILS[0])).toEqual(before);
    // The share from sparse came back with the new demo account.
    expect((await snapshot(EMAILS[2])).shares).toBe(1);
  });

  it('--share-with gives an existing account a view of the persona, and refuses an unknown one before writing', async () => {
    const unknown = await seedAll('--share-with', 'nobody@example.com');
    expect(unknown).toMatchObject({ status: 1 });
    expect(unknown.stderr).toContain('No account uses nobody@example.com');

    const shared = await run([
      '--persona',
      'demo',
      '--share-with',
      OWNER_EMAIL,
      '--password-stdin',
    ]);
    expect(shared.stdout).toContain(`demo: shared (VIEW) with ${OWNER_EMAIL}`);
    const demoId = await userIdOf(t, EMAILS[0]);
    const theirs = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${demoId}`,
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body).toContain('Olive chore coat');
  });

  it('rolls a persona back whole, photos included, when a write fails', async () => {
    const files = await storedFiles();
    const sparse = loadPersona('sparse');
    const broken = {
      ...sparse,
      account: { ...sparse.account, email: 'broken@closet.invalid' },
      outfits: [{ ...sparse.outfits[0], garmentIds: ['S01', 'S99'] }],
    };
    await expect(
      seedPersona(
        { db: t.db, photos: t.photos, logger: t.logger, timeZone: 'UTC' },
        broken,
        { anchor: ANCHOR, password: PASSWORD },
      ),
    ).rejects.toThrow();
    const [row] = await t.db
      .select()
      .from(user)
      .where(eq(user.email, 'broken@closet.invalid'));
    expect(row).toBeUndefined();
    expect(await storedFiles()).toEqual(files);
  });

  it('--remove deletes every row and photo file, and reconciliation finds nothing left', async () => {
    const removed = await run(['--persona', 'all', '--remove']);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain('demo: removed');
    expect(await personaIds()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
    expect(await t.db.$count(garment)).toBe(0);
    expect(await t.db.$count(file)).toBe(0);
    const report = await reconcileStorage(
      { db: t.db, photos: t.photos, logger: t.logger },
      { dryRun: true, olderThanMs: 0 },
    );
    expect(report).toMatchObject({
      orphanedObjectsDeleted: 0,
      orphanedRowsDeleted: 0,
      missingOriginals: 0,
    });

    const again = await run(['--persona', 'demo', '--remove']);
    expect(again.stdout).toContain('demo: not seeded, nothing to remove');
  });

  it('refuses usage it does not understand', async () => {
    for (const args of [
      [],
      ['--persona', 'nobody'],
      ['--persona', 'demo', '--reset', '--remove'],
      ['--persona', 'demo', '--anchor', '2026-02-30'],
    ]) {
      expect((await run(args)).status).toBe(2);
    }
  });
});
