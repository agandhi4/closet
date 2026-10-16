import type { Logger } from '../../logger';
import type { WriteProbe } from '../../storage-probe';

/**
 * The /health/ready contract (~/.claude/conventions/observability.md,
 * Health Contract): each check is `up` or `down`; a `required: false` one
 * is reported without making the app down. devkit's contract_probe.sh
 * (`--health`, in scripts/smoke-image.sh) asserts the shape.
 *
 * The body is unauthenticated: a check names what is wrong (a stuck job's
 * name, a pointer to the fix), never an exception's text or the roster of
 * everything that is fine. The detail goes to the log.
 */
export interface HealthCheck {
  status: 'up' | 'down';
  required: boolean;
  fix?: string;
  /** cron_jobs: the jobs whose run has been in flight past STUCK_AFTER_MS. */
  stuck?: string[];
}

export interface Readiness {
  status: 'up' | 'down';
  version: string;
  checks: Record<string, HealthCheck>;
}

/** Down exactly when a required check is down. */
export function readiness(
  version: string,
  checks: Record<string, HealthCheck>,
): Readiness {
  const down = Object.values(checks).some(
    (check) => check.required && check.status === 'down',
  );
  return { status: down ? 'down' : 'up', version, checks };
}

/** The contract's bound on the database round-trip. */
export const DATABASE_TIMEOUT_MS = 3_000;

const FIX = 'see docs/deployment.md#health';

/**
 * The database and the boot's migrations, from one statement:
 * `lastMigrationAt` (src/db/migrate.ts) answering within `timeoutMs` is the
 * round-trip; its value at or past `buildSchemaAt` (this build's newest
 * migration) is the schema this build needs. A database that does not
 * answer leaves the schema unknown, so both are down. A pool with no free
 * connection counts against the bound too: the statement still runs when
 * one frees, and the rate limit bounds how many can wait.
 */
export async function checkDatabase(
  lastMigrationAt: () => Promise<number | undefined>,
  buildSchemaAt: number,
  logger: Logger,
  timeoutMs: number = DATABASE_TIMEOUT_MS,
): Promise<{ database: HealthCheck; migrations: HealthCheck }> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  let last: number | undefined | 'timeout';
  try {
    // race() subscribes to the read, so its rejection after the bound is
    // handled, never an unhandled one.
    last = await Promise.race([lastMigrationAt(), expired]);
  } catch (error) {
    logger.warn({ err: error }, 'Readiness: the database query failed');
    return { database: down(true), migrations: down(true) };
  } finally {
    clearTimeout(timer);
  }
  if (last === 'timeout') {
    logger.warn(`Readiness: the database did not answer in ${timeoutMs} ms`);
    return { database: down(true), migrations: down(true) };
  }
  const database: HealthCheck = { status: 'up', required: true };
  if (last === undefined || last < buildSchemaAt) {
    logger.warn(
      `Readiness: the database's newest migration (${last ?? 'none'}) is older than this build's (${buildSchemaAt})`,
    );
    return { database, migrations: down(true) };
  }
  return { database, migrations: { status: 'up', required: true } };
}

/**
 * The timers serve() started (JobRoster.stuck): optional, since every page
 * still serves while a job is stuck, and a restart loop would cost the
 * household the app for a job that may finish. Down when nothing was
 * adopted: this process schedules nothing (the integration harness).
 */
export function checkJobs(stuck: string[] | undefined): HealthCheck {
  if (stuck === undefined) return down(false);
  if (stuck.length > 0) return { ...down(false), stuck };
  return { status: 'up', required: false };
}

/** The background-removal queue (CutoutQueue.running); optional like the timers. */
export function checkCutoutQueue(running: boolean): HealthCheck {
  return running ? { status: 'up', required: false } : down(false);
}

/** How long a storage verdict is reused: a probe writes to disk (and NFS). */
const STORAGE_PROBE_TTL_MS = 5_000;

export interface StorageCheckDeps {
  /** DATA_PATH and MODELS_PATH, as the process sees them. */
  directories: readonly string[];
  /** probeWritable (src/storage-probe.ts); the specs pass it too, on tmp dirs. */
  probe: (directory: string) => Promise<WriteProbe>;
  /** ownershipFix (src/storage-probe.ts): the chown, with the process's uid:gid. */
  fix: (unwritable: readonly string[]) => string;
  logger: Logger;
  ttlMs?: number;
  now?: () => number;
}

/**
 * `storage` (required): every directory the process writes at runtime is
 * writable by it. Required because the image runs non-root and its
 * directories are host mounts (docs/deployment.md#permissions): with a
 * root-owned one every page would serve and the first upload or the model
 * download would fail, so readiness would lie. The fix names the chown.
 *
 * One probe per STORAGE_PROBE_TTL_MS whatever the request rate (the
 * HEALTHCHECK, the smoke's poll and anyone within HEALTH_LIMIT share it),
 * and concurrent callers await the same probe.
 */
export function createStorageCheck({
  directories,
  probe,
  fix,
  logger,
  ttlMs = STORAGE_PROBE_TTL_MS,
  now = Date.now,
}: StorageCheckDeps): () => Promise<HealthCheck> {
  let cached: { at: number; verdict: Promise<HealthCheck> } | undefined;
  const run = async (): Promise<HealthCheck> => {
    const results = await Promise.all(directories.map(probe));
    const unwritable = directories.filter((directory, i) => {
      const result = results[i];
      if (result.writable) return false;
      logger.warn(
        `Readiness: ${directory} is not writable by this process (${result.code})`,
      );
      return true;
    });
    return unwritable.length === 0
      ? { status: 'up', required: true }
      : { status: 'down', required: true, fix: fix(unwritable) };
  };
  return () => {
    const at = now();
    if (!cached || at - cached.at >= ttlMs) {
      cached = { at, verdict: run() };
    }
    return cached.verdict;
  };
}

function down(required: boolean): HealthCheck {
  return { status: 'down', required, fix: FIX };
}
