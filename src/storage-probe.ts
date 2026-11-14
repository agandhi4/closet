import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The bytes a probe writes: enough that a full disk or an exhausted quota
 * (ENOSPC, EDQUOT) refuses the write, as it would an upload, where an empty
 * file would still be created.
 */
export const PROBE_BYTES = 4096;

/** The filesystem calls a probe makes; the unit specs inject failing ones. */
export interface ProbeFs {
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (
    path: string,
    data: Uint8Array,
    options: { flag: 'wx' },
  ) => Promise<void>;
  rm: (path: string, options: { force: true }) => Promise<void>;
}

const nodeFs: ProbeFs = { mkdir, writeFile, rm };

/**
 * Whether this process can write a directory it needs at runtime: DATA_PATH
 * (photos) and MODELS_PATH (the cutout model's download). Used by
 * main.ts (DATA_PATH at boot) and
 * /health/ready's `storage` check (src/web/health/checks.ts).
 *
 * Why a real write and not mode bits or access(W_OK): the image runs as an
 * unprivileged user (uid 1000, docs/operations.md#permissions) and its
 * directories are host bind mounts, one of them NFS with all users squashed
 * to the NAS admin. Only the server decides there, and a create + unlink is
 * the one question every filesystem answers truthfully.
 *
 * The directory is created when missing, as its writers do (PhotoStorage's
 * prepare, CutoutModel's download), so "not writable" means exactly what
 * the first upload or download would hit. The probe file is a dotfile:
 * reconciliation and the /file routes only ever see stored photo names.
 *
 * The file is named for this process, not randomly: a write that hangs on a
 * stalled share (the readiness check gives up on it, checks.ts) may never
 * unlink, and the next probe removes that leftover before writing its own.
 */
export type WriteProbe = { writable: true } | { writable: false; code: string };

export async function probeWritable(
  directory: string,
  fs: ProbeFs = nodeFs,
): Promise<WriteProbe> {
  const probe = join(directory, `.write-probe-${process.pid}`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.rm(probe, { force: true });
    // `wx`: never truncate or follow anything already at that name.
    await fs.writeFile(probe, new Uint8Array(PROBE_BYTES), { flag: 'wx' });
    await fs.rm(probe, { force: true });
    return { writable: true };
  } catch (error) {
    // A write that failed midway (ENOSPC) can leave a partial file.
    await fs.rm(probe, { force: true }).catch(() => undefined);
    // fs/promises rejects with ErrnoExceptions, so `code` is always set.
    return {
      writable: false,
      code: String((error as NodeJS.ErrnoException).code),
    };
  }
}

export interface StorageFailure {
  directory: string;
  code: string;
}

/**
 * What the operator does about each kind of failed probe, keyed by its code
 * (the table is the one place a new code gets its words). The directories
 * are named as the container sees them, since only the host knows what is
 * mounted there; the chown carries this process's own uid:gid, never a
 * hardcoded one.
 */
const FIXES: readonly {
  codes: readonly string[];
  say: (where: string) => string;
}[] = [
  {
    codes: ['EACCES', 'EPERM'],
    say: (where) =>
      `chown -R ${processOwner()} the host directory mounted at ${where}; docs/operations.md#permissions`,
  },
  {
    codes: ['ENOSPC', 'EDQUOT'],
    say: (where) => `the share mounted at ${where} is full`,
  },
  {
    codes: ['TIMEOUT'],
    say: (where) =>
      `the share mounted at ${where} is not answering (NFS stalled?)`,
  },
];

/** Used for a code no row claims (EROFS, EIO, ENOTDIR, ...). */
const GENERIC_FIX = (where: string): string =>
  `${where} cannot be written; docs/operations.md#permissions`;

/** The fix for each distinct kind of failure, joined; never the path value of an error. */
export function storageFix(failures: readonly StorageFailure[]): string {
  const claimed = new Set(FIXES.flatMap((row) => row.codes));
  const groups = [
    ...FIXES.map((row) => ({
      say: row.say,
      failures: failures.filter((f) => row.codes.includes(f.code)),
    })),
    {
      say: GENERIC_FIX,
      failures: failures.filter((f) => !claimed.has(f.code)),
    },
  ];
  return groups
    .filter((group) => group.failures.length > 0)
    .map((group) =>
      group.say(group.failures.map((f) => f.directory).join(' and ')),
    )
    .join('; ');
}

function processOwner(): string {
  // Both exist on every platform closet runs on (POSIX; Windows is not one).
  const { getuid, getgid } = process as Required<
    Pick<NodeJS.Process, 'getuid' | 'getgid'>
  >;
  return `${getuid()}:${getgid()}`;
}
