import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'path';
import { File } from '../../dal/entity/file.entity';
import { FileService } from '../file-service.abstract';
import { StoredObject } from '../file-service.interface';

// Writes land here first and are renamed into DATA_PATH when complete (same
// filesystem, so the rename is atomic). A reader, such as the thumb writer
// running while a large cutout is still arriving, sees either no file or the
// whole file, never a prefix. list() skips directories, so reconciliation
// never sees in-flight writes.
const INCOMING_DIR = '.incoming';
const STALE_INCOMING_MS = 60 * 60 * 1000;

@Injectable()
export class LocalFileService extends FileService {
  private directory: string;
  private incoming: string;

  constructor(
    readonly configService: ConfigService,
    @InjectRepository(File) fileRepository: EntityRepository<File>,
    em: EntityManager,
  ) {
    super(configService, fileRepository, em);
    this.directory = configService.getOrThrow('DATA_PATH');
    this.incoming = path.join(this.directory, INCOMING_DIR);
    this.setupDir();
  }

  async get(fileName: string): Promise<Readable> {
    const filePath = path.join(this.directory, fileName);
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      throw new NotFoundException(fileName);
    }
    return fs.createReadStream(filePath);
  }

  // A missing file is the normal case for deleteVariants (most photos have
  // no cutout), so only a real failure is worth a warning.
  async delete(fileName: string): Promise<void> {
    await fs.promises
      .unlink(path.join(this.directory, fileName))
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') this.logger.warn(err);
      });
  }

  // DATA_PATH also holds app.log; every entry is
  // reported and the caller decides what is a photo (parseStoredName).
  async *list(): AsyncIterable<StoredObject> {
    const entries = await fs.promises.readdir(this.directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.promises.stat(
        path.join(this.directory, entry.name),
      );
      yield { name: entry.name, lastModified: stat.mtime };
    }
  }

  protected async store(fileName: string, stream: Readable): Promise<void> {
    const tempPath = path.join(this.incoming, `${randomUUID()}-${fileName}`);
    try {
      await pipeline(stream, fs.createWriteStream(tempPath));
      await fs.promises.rename(tempPath, path.join(this.directory, fileName));
    } catch (error) {
      // `force` covers a stream that failed before the file was opened.
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }
  }

  // A temp file untouched for an hour is a write whose process died (crash,
  // kill mid-upload); no row can point at it. Only stale ones go: the
  // reconcile CLI boots a second app on the same DATA_PATH while the server
  // may be mid-write, and a live write keeps its mtime fresh.
  setupDir() {
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
}
