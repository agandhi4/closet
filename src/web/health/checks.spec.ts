import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import {
  PROBE_BYTES,
  ownershipFix,
  probeWritable,
  type ProbeFs,
  type WriteProbe,
} from '../../storage-probe';
import {
  checkCutoutQueue,
  checkDatabase,
  checkJobs,
  createStorageCheck,
  type HealthCheck,
  readiness,
} from './checks';

/**
 * /health/ready's verdict and checks with their inputs stubbed: the 503
 * paths no healthy integration database can show. The real round-trip is
 * test/integration/delivery.spec.ts.
 */

const up = (required: boolean): HealthCheck => ({ status: 'up', required });
const down = (required: boolean): HealthCheck => ({ status: 'down', required });

describe('readiness', () => {
  it.each([
    ['every check up', { a: up(true), b: up(false) }, 'up'],
    ['an optional check down', { a: up(true), b: down(false) }, 'up'],
    ['a required check down', { a: down(true), b: up(false) }, 'down'],
  ])('%s: %s', (_case, checks, status) => {
    expect(readiness('abc1234', checks)).toEqual({
      status,
      version: 'abc1234',
      checks,
    });
  });
});

describe('checkDatabase', () => {
  const BUILD = 1_700_000_000_000;
  const { logger, logs } = captureLogs();

  it.each([
    ['current', BUILD, 'up'],
    ['ahead (an older build rolled back onto it)', BUILD + 1, 'up'],
    ['behind', BUILD - 1, 'down'],
    ['with no migration recorded', undefined, 'down'],
  ])('a database %s: migrations %s', async (_case, last, migrations) => {
    const checks = await checkDatabase(
      () => Promise.resolve(last),
      BUILD,
      logger,
    );
    expect(checks.database).toEqual(up(true));
    expect(checks.migrations.status).toBe(migrations);
    expect(checks.migrations.required).toBe(true);
  });

  it('a failed query is down, its text only in the log', async () => {
    logs.clear();
    const failure = new Error('connect ECONNREFUSED 10.0.0.5:5433 closet_user');
    const checks = await checkDatabase(
      () => Promise.reject(failure),
      BUILD,
      logger,
    );
    expect(checks.database.status).toBe('down');
    expect(checks.migrations.status).toBe('down');
    expect(JSON.stringify(checks)).not.toContain('ECONNREFUSED');
    expect(logs.messages('warn')).toEqual([
      'Readiness: the database query failed',
    ]);
  });

  it('a query that outlasts the bound is down', async () => {
    const checks = await checkDatabase(
      () => new Promise<never>(() => {}),
      BUILD,
      logger,
      5,
    );
    expect(checks.database).toMatchObject(down(true));
    expect(checks.migrations).toMatchObject(down(true));
  });
});

describe('checkJobs and checkCutoutQueue', () => {
  it('are optional, down when nothing was started or a job is stuck', () => {
    expect(checkJobs([])).toEqual(up(false));
    expect(checkJobs(undefined)).toMatchObject(down(false));
    expect(checkJobs(['Week re-plan'])).toMatchObject({
      ...down(false),
      stuck: ['Week re-plan'],
    });
    expect(checkCutoutQueue(true)).toEqual(up(false));
    expect(checkCutoutQueue(false)).toMatchObject(down(false));
  });
});

describe('createStorageCheck', () => {
  const { logger, logs } = captureLogs();
  let root: string;
  let writable: string;
  let readOnly: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'closet-storage-'));
    writable = join(root, 'data');
    readOnly = join(root, 'models');
    // Created by the probe, as its writers would.
    await probeWritable(readOnly);
    await chmod(readOnly, 0o555);
  });
  afterAll(async () => {
    await chmod(readOnly, 0o755);
    await rm(root, { recursive: true, force: true });
  });

  const IDENTITY_FIX = 'see docs/operations.md#photo-storage-marker';
  const check = (
    directories: string[],
    identity: () => Promise<string | undefined> = () =>
      Promise.resolve(undefined),
  ) =>
    createStorageCheck({
      directories,
      probe: probeWritable,
      fix: ownershipFix,
      identity,
      identityFix: IDENTITY_FIX,
      logger,
    })();

  it('is up when every directory can be written, created if missing, and leaves nothing behind', async () => {
    expect(await check([writable])).toEqual(up(true));
    expect(await readdir(writable)).toEqual([]);
  });

  // Root writes through mode bits: the read-only case means nothing there.
  it.skipIf(process.getuid?.() === 0)(
    'is down with the chown for exactly the read-only directory, the error code only in the log',
    async () => {
      logs.clear();
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      expect(await check([writable, readOnly])).toEqual({
        status: 'down',
        required: true,
        fix: `chown -R ${uid}:${gid} the host directory mounted at ${readOnly}; docs/operations.md#permissions`,
      });
      expect(logs.messages('warn')).toEqual([
        `Readiness: ${readOnly} is not writable by this process (EACCES)`,
      ]);
    },
  );

  // #650: an unmounted share is a writable, empty mountpoint.
  it('is down with the marker pointer when DATA_PATH is not the claimed storage', async () => {
    logs.clear();
    expect(await check([writable], () => Promise.resolve('no marker'))).toEqual(
      { status: 'down', required: true, fix: IDENTITY_FIX },
    );
    expect(logs.messages('warn')).toEqual(['Readiness: no marker']);
  });

  it('is down, never a rejection, when the marker check itself fails', async () => {
    logs.clear();
    expect(
      await check([writable], () => Promise.reject(new Error('EIO'))),
    ).toEqual({ status: 'down', required: true, fix: IDENTITY_FIX });
    expect(logs.messages('warn')).toEqual([
      'Readiness: the storage marker check failed',
      'Readiness: the storage marker could not be checked',
    ]);
  });

  it('probes once per TTL, concurrent callers sharing the probe', async () => {
    let probes = 0;
    let clock = 0;
    const storage = createStorageCheck({
      directories: ['/app/data', '/app/models'],
      probe: (): Promise<WriteProbe> => {
        probes += 1;
        return Promise.resolve({ writable: true });
      },
      fix: ownershipFix,
      identity: () => Promise.resolve(undefined),
      identityFix: IDENTITY_FIX,
      logger,
      ttlMs: 5_000,
      now: () => clock,
    });
    await Promise.all([storage(), storage(), storage()]);
    expect(probes).toBe(2);
    clock = 4_999;
    await storage();
    expect(probes).toBe(2);
    clock = 5_000;
    await storage();
    expect(probes).toBe(4);
  });

  describe('a full disk and a stalled share', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const enospc = (): never => {
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    };

    it('writes PROBE_BYTES and reports ENOSPC from the write, code only, cleaning up', async () => {
      const writes: number[] = [];
      const removed: string[] = [];
      const fs: ProbeFs = {
        mkdir: () => Promise.resolve(),
        writeFile: (_path, data) => {
          writes.push(data.byteLength);
          return Promise.resolve().then(enospc);
        },
        rm: (path) => {
          removed.push(path);
          return Promise.resolve();
        },
      };
      expect(await probeWritable('/app/data', fs)).toEqual({
        writable: false,
        code: 'ENOSPC',
      });
      expect(writes).toEqual([PROBE_BYTES]);
      expect(removed.at(-1)).toBe(`/app/data/.write-probe-${process.pid}`);

      logs.clear();
      const storage = createStorageCheck({
        directories: ['/app/data'],
        probe: (directory) => probeWritable(directory, fs),
        fix: ownershipFix,
        identity: () => Promise.resolve(undefined),
        identityFix: IDENTITY_FIX,
        logger,
      });
      expect(await storage()).toMatchObject({ status: 'down', required: true });
      expect(logs.messages('warn')).toEqual([
        'Readiness: /app/data is not writable by this process (ENOSPC)',
      ]);
    });

    it('reports TIMEOUT at 3 s for a probe that never settles, then probes afresh after the window', async () => {
      vi.useFakeTimers();
      logs.clear();
      let probes = 0;
      let hang = true;
      const storage = createStorageCheck({
        directories: ['/app/data'],
        probe: (): Promise<WriteProbe> => {
          probes += 1;
          return hang
            ? new Promise<WriteProbe>(() => undefined)
            : Promise.resolve({ writable: true });
        },
        fix: ownershipFix,
        identity: () => Promise.resolve(undefined),
        identityFix: IDENTITY_FIX,
        logger,
      });
      let verdict: HealthCheck | undefined;
      void storage().then((v) => (verdict = v));
      await vi.advanceTimersByTimeAsync(2_999);
      expect(verdict).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(verdict).toMatchObject({ status: 'down', required: true });
      expect(logs.messages('warn')).toEqual(
        ['/app/data is not writable by this process (TIMEOUT)'].map(
          (m) => `Readiness: ${m}`,
        ),
      );

      // Inside the window: the verdict is reused, and still one log line.
      await storage();
      expect(probes).toBe(1);
      expect(logs.messages('warn')).toHaveLength(1);

      // Past it: a fresh probe, though the first never settled.
      hang = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await storage()).toEqual(up(true));
      expect(probes).toBe(2);
    });
  });
});
