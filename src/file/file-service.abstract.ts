import { EntityManager, EntityRepository } from '@mikro-orm/core';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MultipartFile } from '@fastify/multipart';
import { randomUUID } from 'crypto';
import { join } from 'path';
import sharp from 'sharp';
import Stream, { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { File } from '../dal/entity/file.entity';
import { FileServiceInterface } from './file-service.interface';
import { IMAGE_VARIANTS, ImageVariant, variantFileName } from './image-variant';
import { PROJECT_ROOT } from '../project-root';

const IMAGE_MAX_PX = 1080;
const IMAGE_QUALITY = 90;
const THUMB_MAX_PX = 400;
const THUMB_QUALITY = 80;

/**
 * Everything about a photo except the bytes: variant naming, transcoding,
 * thumbnail derivation, versioning and the File rows. Backends only provide
 * the three storage primitives (`get`, `store`, `delete`).
 */
@Injectable()
export abstract class FileService implements FileServiceInterface {
  public logger = new Logger(FileService.name);

  // Pending thumb write per original file name. Writes are chained rather
  // than deduplicated so that on a fresh upload, where the original and the
  // cutout land concurrently, the cutout's thumb always wins; lazy reads join
  // the write already in flight instead of starting a duplicate.
  private readonly thumbJobs = new Map<string, Promise<void>>();

  constructor(
    readonly configService: ConfigService,
    protected readonly fileRepository: EntityRepository<File>,
    protected readonly em: EntityManager,
  ) {}

  /** Must reject with NotFoundException when the file does not exist. */
  abstract get(fileName: string): Promise<Readable>;
  /** Missing files are not an error. */
  abstract delete(fileName: string): Promise<void>;
  protected abstract store(fileName: string, stream: Readable): Promise<void>;

  async storeImageFromFileUpload(
    upload: MultipartFile | undefined,
    userId: any,
    fileName?: string,
  ): Promise<File> {
    if (!upload) {
      throw new HttpException('No file uploaded', HttpStatus.BAD_REQUEST);
    }
    // https://github.com/fastify/fastify-multipart/issues/497
    // Unconsumed multipart streams can hang the request; drain before throwing
    if (!upload.mimetype?.startsWith('image/')) {
      upload.file.resume();
      throw new HttpException('Wrong filetype', HttpStatus.BAD_REQUEST);
    }

    const storedFileName = fileName ?? `${randomUUID()}.webp`;
    await this.transcode(
      upload.file,
      this.imageTransformer().autoOrient(),
      storedFileName,
    );

    // repository.create => persist pattern so that the @BeforeCreate hook
    // fires and generates the shareableId
    const file = this.fileRepository.create({
      fileName: storedFileName,
      createdOn: new Date().toISOString(),
      createdBy: userId,
    });
    await this.em.persistAndFlush(file);
    await this.regenerateThumb(storedFileName);
    this.logger.log(`Stored upload ${storedFileName} for user ${userId}`);
    return file;
  }

  /**
   * Byte-for-byte copy of the original and, when present, the cutout under a
   * fresh name with its own File row. Returns undefined when the source is
   * gone from storage (the row can outlive the bytes).
   */
  async copyImage(
    sourceFileName: string,
    userId?: number,
  ): Promise<File | undefined> {
    const source = await this.getIfExists(sourceFileName);
    if (!source) {
      this.logger.warn(`copyImage: source ${sourceFileName} is missing`);
      return undefined;
    }

    const newFileName = `${randomUUID()}.webp`;
    await this.store(newFileName, source);

    const nobgSource = await this.getIfExists(
      variantFileName(sourceFileName, 'nobg'),
    );
    if (nobgSource) {
      await this.store(variantFileName(newFileName, 'nobg'), nobgSource);
    }

    const file = this.fileRepository.create({
      fileName: newFileName,
      createdOn: new Date().toISOString(),
      createdBy: userId,
    });
    await this.em.persistAndFlush(file);
    await this.regenerateThumb(newFileName);
    this.logger.log(`Copied ${sourceFileName} to ${newFileName}`);
    return file;
  }

  /**
   * Writes the background-removed cutout for `originalFileName` and refreshes
   * its thumb. Unless the cutout belongs to a photo uploaded in the same
   * request (`newUpload`), clients may already hold the old nobg and thumb
   * under the current version, so the File version is bumped; the thumb is
   * rewritten before the bump so no client can cache a stale thumb under the
   * new version.
   */
  async storeNobgVariantFromStream(
    stream: Readable,
    originalFileName: string,
    { newUpload }: { newUpload: boolean },
  ): Promise<void> {
    const nobgName = variantFileName(originalFileName, 'nobg');
    await this.transcode(stream, this.imageTransformer(), nobgName);
    await this.regenerateThumb(originalFileName);
    if (!newUpload) {
      await this.bumpVersion(originalFileName);
    }
    this.logger.log(
      `Stored cutout ${nobgName}${newUpload ? '' : ' (replaced, version bumped)'}`,
    );
  }

  /**
   * Streams a variant, falling back gracefully: a missing cutout serves the
   * original, a missing thumb is generated on first request (backfill for
   * photos stored before thumbs existed). Rejects with NotFoundException only
   * when the original itself is gone.
   */
  async getVariant(fileName: string, variant: ImageVariant): Promise<Readable> {
    switch (variant) {
      case 'original':
        return this.get(fileName);
      case 'nobg':
        return (
          (await this.getIfExists(variantFileName(fileName, 'nobg'))) ??
          this.get(fileName)
        );
      case 'thumb': {
        const thumbName = variantFileName(fileName, 'thumb');
        const existing = await this.getIfExists(thumbName);
        if (existing) return existing;
        await (this.thumbJobs.get(fileName) ?? this.regenerateThumb(fileName));
        return this.get(thumbName);
      }
    }
  }

  /** Rewrites the thumb from the cutout if present, else from the original. */
  regenerateThumb(fileName: string): Promise<void> {
    const previous = this.thumbJobs.get(fileName) ?? Promise.resolve();
    const job = previous
      .catch(() => undefined)
      .then(() => this.writeThumb(fileName))
      .finally(() => {
        if (this.thumbJobs.get(fileName) === job) {
          this.thumbJobs.delete(fileName);
        }
      });
    this.thumbJobs.set(fileName, job);
    return job;
  }

  /** Returns the new version, or undefined when no File row matches. */
  async bumpVersion(fileName: string): Promise<number | undefined> {
    const file = await this.fileRepository.findOne({ fileName });
    if (!file) {
      this.logger.warn(`bumpVersion: no File row for ${fileName}`);
      return undefined;
    }
    file.version += 1;
    await this.em.persistAndFlush(file);
    this.logger.log(`Bumped ${fileName} to version ${file.version}`);
    return file.version;
  }

  /** Removes every variant; missing ones are normal and only logged. */
  async deleteVariants(fileName: string): Promise<void> {
    for (const variant of IMAGE_VARIANTS) {
      const name = variantFileName(fileName, variant);
      await this.delete(name).catch((err) =>
        this.logger.warn(`Failed to delete ${name}: ${err}`),
      );
    }
    this.logger.log(`Deleted variants of ${fileName}`);
  }

  async deleteById(fileId: any, userId: any): Promise<void> {
    const file = await this.fileRepository.findOneOrFail({
      id: fileId,
      createdBy: userId,
    });
    await this.deleteVariants(file.fileName);
    await this.em.removeAndFlush(file);
  }

  async getByShareableId(shareableId: string): Promise<Readable> {
    const file = await this.fileRepository.findOneOrFail({ shareableId });
    return this.get(file.fileName);
  }

  private imageTransformer(): sharp.Sharp {
    return sharp()
      .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, {
        fit: sharp.fit.inside,
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_QUALITY });
  }

  private async writeThumb(fileName: string): Promise<void> {
    const source =
      (await this.getIfExists(variantFileName(fileName, 'nobg'))) ??
      (await this.get(fileName));
    const thumbName = variantFileName(fileName, 'thumb');
    const startedAt = Date.now();
    await this.transcode(
      source,
      sharp()
        .resize(THUMB_MAX_PX, THUMB_MAX_PX, {
          fit: sharp.fit.inside,
          withoutEnlargement: true,
        })
        .webp({ quality: THUMB_QUALITY }),
      thumbName,
    );
    this.logger.debug(`Wrote ${thumbName} in ${Date.now() - startedAt}ms`);
  }

  // Runs the source through sharp into the backend's store. Both sides are
  // awaited together: pipeline() ending the PassThrough is what tells the
  // store (an S3 Upload or a file write) that the body is complete.
  private async transcode(
    source: Readable,
    transformer: sharp.Sharp,
    targetFileName: string,
  ): Promise<void> {
    const passThrough = new Stream.PassThrough();
    try {
      await Promise.all([
        this.store(targetFileName, passThrough),
        pipeline(source, transformer, passThrough),
      ]);
    } catch (error) {
      passThrough.destroy();
      throw error;
    }
  }

  private async getIfExists(fileName: string): Promise<Readable | undefined> {
    try {
      return await this.get(fileName);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }

  async getWatermark() {
    return sharp(
      join(
        PROJECT_ROOT,
        'public',
        'assets',
        this.configService.getOrThrow('ICON_NAME'),
      ),
    )
      .resize(150, 150)
      .extend({
        top: 0,
        bottom: 20,
        left: 20,
        right: 0,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .composite([
        {
          input: Buffer.from([0, 0, 0, 200]),
          raw: {
            width: 1,
            height: 1,
            channels: 4,
          },
          tile: true,
          blend: 'dest-in',
        },
      ])
      .toBuffer();
  }

  // Serves share-link Open Graph previews. The icon composite is opt-in via
  // WATERMARK_ENABLED; the resize to JPEG always happens.
  async watermarkImage(
    fileStream: Stream.Readable | undefined,
  ): Promise<Readable | undefined> {
    if (!fileStream) {
      return undefined;
    }
    const transformer = sharp()
      .jpeg()
      .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, { fit: sharp.fit.inside });
    if (this.configService.get<boolean>('WATERMARK_ENABLED')) {
      const watermark = await this.getWatermark();
      transformer.composite([{ input: watermark, gravity: 'southwest' }]);
    }
    return fileStream.pipe(transformer);
  }
}
