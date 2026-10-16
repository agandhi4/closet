import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Whether this process can write a directory it needs at runtime: DATA_PATH
 * (photos, app.log) and MODELS_PATH (the cutout model's download). Used by
 * main.ts (DATA_PATH at boot: the logger opens app.log there) and
 * /health/ready's `storage` check (src/web/health/checks.ts).
 *
 * Why a real write and not mode bits or access(W_OK): the image runs as an
 * unprivileged user (uid 1000, docs/deployment.md#permissions) and its
 * directories are host bind mounts, one of them NFS with all users squashed
 * to the NAS admin. Only the server decides there, and a create + unlink is
 * the one question every filesystem answers truthfully.
 *
 * The directory is created when missing, as its writers do (PhotoStorage's
 * prepare, CutoutModel's download), so "not writable" means exactly what
 * the first upload or download would hit. The probe file is a dotfile:
 * reconciliation and the /file routes only ever see stored photo names.
 */
export type WriteProbe = { writable: true } | { writable: false; code: string };

export async function probeWritable(directory: string): Promise<WriteProbe> {
  const probe = join(directory, `.write-probe-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    // `wx`: never truncate or follow anything already at that name.
    const handle = await open(probe, 'wx');
    await handle.close();
    await unlink(probe);
    return { writable: true };
  } catch (error) {
    // fs/promises rejects with ErrnoExceptions, so `code` is always set.
    return {
      writable: false,
      code: String((error as NodeJS.ErrnoException).code),
    };
  }
}

/**
 * What the operator runs, with this process's own uid:gid (never a
 * hardcoded one): the directories are named as the container sees them,
 * since only the host knows what is mounted there.
 */
export function ownershipFix(directories: readonly string[]): string {
  return `chown -R ${processOwner()} the host directory mounted at ${directories.join(' and ')}; docs/deployment.md#permissions`;
}

function processOwner(): string {
  // Both exist on every platform closet runs on (POSIX; Windows is not one).
  const { getuid, getgid } = process as Required<
    Pick<NodeJS.Process, 'getuid' | 'getgid'>
  >;
  return `${getuid()}:${getgid()}`;
}
