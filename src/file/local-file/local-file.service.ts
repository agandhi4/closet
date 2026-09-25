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

  async delete(fileName: string): Promise<void> {
    await fs.promises
      .unlink(path.join(this.directory, fileName))
      .catch((err) => this.logger.warn(err));
  }

  protected async store(fileName: string, stream: Readable): Promise<void> {
    await pipeline(
      stream,
      fs.createWriteStream(path.join(this.directory, fileName)),
    );
  }

  setupDir() {
    if (!fs.existsSync(this.directory)) {
      this.logger.debug('creating uploads directory');
      fs.mkdirSync(this.directory, { recursive: true });
    }
    this.logger.debug('uploads directory exists');
  }
}
