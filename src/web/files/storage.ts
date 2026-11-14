import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '../../logger';

// Writes land here first and are renamed into DATA_PATH when complete (same
// filesystem, so the rename is atomic). A reader, such as the thumb writer
// running while a large cutout is still arriving, sees either no file or the
// whole file, never a prefix. list() skips directories, so reconciliation
// never sees in-flight writes.
const INCOMING_DIR = '.incoming';
const STALE_INCOMING_MS = 60 * 60 * 1000;

/**
 * The directory's identity (#650): written once, by claimStorage
 * (storage-identity.ts), when this process can prove DATA_PATH is the
 * household's photo storage. A bare mountpoint (the share not mounted)
 * lacks it, so it is never read as "every photo is gone". A dotfile:
 * parseStoredName refuses it, so /file/** never serves it, and list()
 * skips it, so reconciliation never counts it.
 */
export const STORAGE_MARKER = '.closet-storage';

export interface StorageMarker {
  /** A random UUID, stable for the life of the storage. */
  installId: string;
  /** ISO timestamp of the write. */
  createdAt: string;
}

/**
 * Why the directory is not the one this process claimed (identityProblem):
 * no marker, another install's, or a marker that cannot be read (a stale
 * NFS handle, EIO, EACCES; MALFORMED content), named by its code only.
 */
export type IdentityProblem =
  | { kind: 'absent' }
  | { kind: 'foreign' }
  | { kind: 'unreadable'; code: string };

/** The marker file as read: never a rejection, so readiness always answers. */
export type MarkerRead =
  | { state: 'present'; marker: StorageMarker }
  | { state: 'absent' }
  | { state: 'unreadable'; code: string };

/**
 * The file operations the marker uses, injectable so a spec can fail a read
 * or hold a writer between its temp file and its link (photo-storage.spec.ts).
 */
export interface MarkerFs {
  readText(file: string): Promise<string>;
  /** Creates `file`, failing with EEXIST when it exists (`wx`). */
  writeNew(file: string, text: string): Promise<void>;
  /** A hard link: fails with EEXIST when `to` exists, so never replaces it. */
  link(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
}

const NODE_MARKER_FS: MarkerFs = {
  readText: (file) => fs.promises.readFile(file, 'utf8'),
  writeNew: (file, text) => fs.promises.writeFile(file, text, { flag: 'wx' }),
  link: (from, to) => fs.promises.link(from, to),
  remove: (file) => fs.promises.rm(file, { force: true }),
};

/** One file in the photo directory; names are as stored, variants included. */
export interface StoredObject {
  name: string;
  lastModified: Date;
}

/**
 * The photo bytes: a flat directory (DATA_PATH).
 * Knows nothing about photos; Photos (photos.ts) names, transcodes and
 * derives, and reconciliation maps names back to rows with parseStoredName.
 */
export class PhotoStorage {
  private readonly incoming: string;
  // The marker this process verified or wrote at boot (claim); compared
  // with the one on disk later, so a share swapped under a running server
  // is noticed too.
  private claimed: StorageMarker | undefined;

  constructor(
    readonly directory: string,
    private readonly logger: Logger,
    private readonly markerFs: MarkerFs = NODE_MARKER_FS,
  ) {
    this.incoming = path.join(directory, INCOMING_DIR);
  }

  /**
   * Creates the directories and removes abandoned partial writes. A temp
   * file untouched for an hour is a write whose process died (crash, kill
   * mid-upload); no row can point at it. Only stale ones go: the reconcile
   * CLI boots a second process on the same DATA_PATH while the server may
   * be mid-write, and a live write keeps its mtime fresh.
   */
  prepare(): void {
    fs.mkdirSync(this.incoming, { recursive: true });
    const staleBefore = Date.now() - STALE_INCOMING_MS;
    for (const name of fs.readdirSync(this.incoming)) {
      const tempPath = path.join(this.incoming, name);
      // Undefined when a live write was renamed into place meanwhile.
      const stat = fs.statSync(tempPath, { throwIfNoEntry: false });
      if (stat && stat.mtimeMs < staleBefore) {
        fs.rmSync(tempPath, { force: true });
        this.logger.warn(`Removed abandoned partial write ${name}`);
      }
    }
  }

  /**
   * The marker on disk. Any read error but ENOENT is `unreadable` with its
   * code, and so is content that is not a marker (MALFORMED).
   */
  async readMarker(): Promise<MarkerRead> {
    let text: string;
    try {
      text = await this.markerFs.readText(this.pathOf(STORAGE_MARKER));
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      if (code === 'ENOENT') return { state: 'absent' };
      this.logger.warn(`${STORAGE_MARKER} could not be read (${code})`);
      return { state: 'unreadable', code };
    }
    const marker = parseMarker(text);
    if (!marker) {
      // Never overwritten: whoever left it there may know better.
      this.logger.warn(`${STORAGE_MARKER} is not a storage marker`);
      return { state: 'unreadable', code: 'MALFORMED' };
    }
    return { state: 'present', marker };
  }

  /**
   * Creates the marker exclusively and returns the one on disk: ours, or,
   * when another process (the server and a CLI booting together) linked
   * its own first, that one, so both claim the same install id. When the
   * one that won cannot be read, that is returned as `unreadable` (its
   * code, never a path) for claimStorage to refuse. The temp
   * file is linked, never renamed: a rename replaces, a link fails with
   * EEXIST. A reader sees no marker or a whole one. Only claimStorage
   * decides that one may be written.
   */
  async createMarker(
    now: Date = new Date(),
  ): Promise<Exclude<MarkerRead, { state: 'absent' }>> {
    const marker: StorageMarker = {
      installId: randomUUID(),
      createdAt: now.toISOString(),
    };
    const tempPath = path.join(this.incoming, `${randomUUID()}-marker`);
    try {
      await this.markerFs.writeNew(tempPath, `${JSON.stringify(marker)}\n`);
      await this.markerFs.link(tempPath, this.pathOf(STORAGE_MARKER));
      return { state: 'present', marker };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readMarker();
      // Gone again between the link and the read: nothing to explain it.
      if (existing.state === 'absent') throw error;
      if (existing.state === 'present') {
        this.logger.info(
          `${STORAGE_MARKER} was written by another process meanwhile; using its install ${existing.marker.installId}`,
        );
      }
      return existing;
    } finally {
      await this.markerFs.remove(tempPath);
    }
  }

  /** Records the marker claimStorage verified; identityProblem compares with it. */
  claim(marker: StorageMarker): void {
    this.claimed = marker;
  }

  /**
   * Whether the directory is still the one this process claimed: no
   * marker (unmounted, or never claimed), another install's, one that
   * cannot be read, or undefined. Read on every call (readiness and each
   * reconciliation run ask: a share can be unmounted under a server), and
   * never rejects for the disk's sake.
   */
  async identityProblem(): Promise<IdentityProblem | undefined> {
    const read = await this.readMarker();
    if (read.state === 'absent') return { kind: 'absent' };
    if (read.state === 'unreadable') {
      return { kind: 'unreadable', code: read.code };
    }
    if (this.claimed && read.marker.installId !== this.claimed.installId) {
      return { kind: 'foreign' };
    }
    return undefined;
  }

  /**
   * The file's bytes, or undefined when there is no such file. Opened before
   * returning, so a file deleted afterwards still streams whole and a
   * missing one is never a stream that fails later.
   */
  async get(fileName: string): Promise<Readable | undefined> {
    try {
      const handle = await fs.promises.open(this.pathOf(fileName), 'r');
      return handle.createReadStream();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async exists(fileName: string): Promise<boolean> {
    const stat = await fs.promises
      .stat(this.pathOf(fileName))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      });
    return stat?.isFile() ?? false;
  }

  /**
   * Atomic: until it resolves, readers see no file under `fileName` (or the
   * previous one), never a partial write; a rejected store leaves nothing
   * behind. Photo and cutout are written concurrently and the thumb writer
   * reads whichever exists, which is why this matters (AGENTS.md Gotchas).
   */
  async store(fileName: string, stream: Readable): Promise<void> {
    const tempPath = path.join(this.incoming, `${randomUUID()}-${fileName}`);
    try {
      await pipeline(stream, fs.createWriteStream(tempPath));
      await fs.promises.rename(tempPath, this.pathOf(fileName));
    } catch (error) {
      // `force` covers a stream that failed before the file was opened.
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }
  }

  /**
   * A missing file is not an error: most photos have no cutout, so
   * deleteVariants asks for files that were never written.
   */
  async delete(fileName: string): Promise<void> {
    await fs.promises.unlink(this.pathOf(fileName)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /** Every file in the directory but the marker; the caller filters. */
  async *list(): AsyncIterable<StoredObject> {
    const entries = await fs.promises.readdir(this.directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === STORAGE_MARKER) continue;
      const stat = await fs.promises
        .stat(this.pathOf(entry.name))
        .catch((error: unknown) => {
          // Deleted between the listing and now: no longer an object.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          }
          throw error;
        });
      if (stat) yield { name: entry.name, lastModified: stat.mtime };
    }
  }

  // Names come from our own code (variantFileName of a stored name, or a
  // route segment parseStoredName accepted); basename() is the last line
  // against a path ever leaving the directory.
  private pathOf(fileName: string): string {
    return path.join(this.directory, path.basename(fileName));
  }
}

function parseMarker(text: string): StorageMarker | undefined {
  try {
    const value = JSON.parse(text) as Partial<StorageMarker> | null;
    if (
      typeof value?.installId === 'string' &&
      value.installId.length > 0 &&
      typeof value.createdAt === 'string'
    ) {
      return { installId: value.installId, createdAt: value.createdAt };
    }
  } catch {
    // Not JSON: not ours.
  }
  return undefined;
}
