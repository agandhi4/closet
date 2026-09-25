import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'path';
import { File } from '../../dal/entity/file.entity';
import { FileService } from '../file-service.abstract';
import { StoredObject } from '../file-service.interface';

@Injectable()
export class LocalFileService extends FileService {
  private directory: string;

  constructor(
    readonly configService: ConfigService,
    @InjectRepository(File) fileRepository: EntityRepository<File>,
    em: EntityManager,
  ) {
    super(configService, fileRepository, em);
    this.directory = configService.getOrThrow('DATA_PATH');
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
    const filePath = path.join(this.directory, fileName);
    try {
      await pipeline(stream, fs.createWriteStream(filePath));
    } catch (error) {
      // A failed pipeline leaves whatever was flushed so far under the final
      // name; `force` covers the case where the stream never opened.
      await fs.promises.rm(filePath, { force: true });
      throw error;
    }
  }

  setupDir() {
    if (!fs.existsSync(this.directory)) {
      this.logger.debug('creating uploads directory');
      fs.mkdirSync(this.directory, { recursive: true });
    }
    this.logger.debug('uploads directory exists');
  }
}
