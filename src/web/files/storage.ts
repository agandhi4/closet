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

/** One file in the photo directory; names are as stored, variants included. */
export interface StoredObject {
  name: string;
  lastModified: Date;
}

/**
 * The photo bytes: a flat directory (DATA_PATH), which also holds app.log.
 * Knows nothing about photos; Photos (photos.ts) names, transcodes and
 * derives, and reconciliation maps names back to rows with parseStoredName.
 */
export class PhotoStorage {
  private readonly incoming: string;

  constructor(
    readonly directory: string,
    private readonly logger: Logger,
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

  /**
   * Atomic: until it resolves, readers see no file under `fileName` (or the
   * previous one), never a partial write; a rejected store leaves nothing
   * behind. Photo and cutout are written concurrently and the thumb writer
   * reads whichever exists, which is why this matters (CLAUDE.md Gotchas).
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

  /** Every file in the directory (app.log included); the caller filters. */
  async *list(): AsyncIterable<StoredObject> {
    const entries = await fs.promises.readdir(this.directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
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
