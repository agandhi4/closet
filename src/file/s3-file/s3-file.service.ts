import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Upload } from '@aws-sdk/lib-storage';
import { InjectS3, type S3 } from 'nestjs-s3';
import { Readable } from 'stream';
import { File } from '../../dal/entity/file.entity';
import { FileService } from '../file-service.abstract';

@Injectable()
export class S3FileService extends FileService {
  private bucketName: string;

  constructor(
    @InjectS3() private readonly s3: S3,
    readonly configService: ConfigService,
    @InjectRepository(File) fileRepository: EntityRepository<File>,
    em: EntityManager,
  ) {
    super(configService, fileRepository, em);
    this.bucketName = configService.get('OBJECT_STORAGE_BUCKET_NAME') as string;
  }

  async get(fileName: string): Promise<Readable> {
    try {
      const result = await this.s3.getObject({
        Bucket: this.bucketName,
        Key: fileName,
      });
      return result.Body as Readable;
    } catch (error) {
      // Normalise the SDK's missing-key error to the base class contract.
      if ((error as { name?: string }).name === 'NoSuchKey') {
        throw new NotFoundException(fileName);
      }
      throw error;
    }
  }

  // S3 returns success for a missing key, matching the base contract.
  async delete(fileName: string): Promise<void> {
    await this.s3.deleteObject({
      Bucket: this.bucketName,
      Key: fileName,
    });
    this.logger.debug(`Deleted object ${fileName}`);
  }

  protected async store(fileName: string, stream: Readable): Promise<void> {
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucketName,
        Key: fileName,
        Body: stream,
        ContentType: 'image/webp',
      },
    });
    await upload.done();
  }
}
