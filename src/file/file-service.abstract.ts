import { EntityManager, EntityRepository } from '@mikro-orm/core';
import {
  BadRequestException,
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
import sharp, { type Sharp } from 'sharp';
import Stream, { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { File } from '../dal/entity/file.entity';
import {
  FileServiceInterface,
  StoreImageOptions,
  StoredObject,
} from './file-service.interface';
import { decodeHeic, isHeicUpload } from './heic';
import { IMAGE_VARIANTS, ImageVariant, variantFileName } from './image-variant';
import { PROJECT_ROOT } from '../project-root';

const IMAGE_MAX_PX = 1080;
const IMAGE_QUALITY = 90;
const THUMB_MAX_PX = 400;
const THUMB_QUALITY = 80;

/**
 * The source side of a transcode failed (undecodable bytes, truncated
 * upload) as opposed to the storage side. Uploads map it to a 400; a thumb
 * rebuild hitting it means our own stored original is corrupt.
 */
export class UnreadableImageError extends Error {
  constructor(readonly cause: unknown) {
    super(`Unreadable image: ${String(cause)}`);
    this.name = 'UnreadableImageError';
  }
}

/**
 * Everything about a photo except the bytes: variant naming, transcoding,
 * thumbnail derivation, versioning and the File rows. Backends only provide
 * the storage primitives (`get`, `store`, `delete`, `list`).
 *
 * Bytes are written before any row exists. The store methods return an
 * unpersisted File so the caller can commit it in the same transaction as the
 * garment that references it, and delete the variants (deleteVariants) if that
 * transaction fails; nothing on disk is ever pointed at by a half-written
 * state.
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
  /**
   * Every object in the store, one page at a time for backends that page.
   * Names are as stored (variants included); StorageReconciliationService
   * maps them back to File rows with parseStoredName.
   */
  abstract list(): AsyncIterable<StoredObject>;
  /**
   * Must be atomic: until it resolves, readers see no object under `fileName`
   * (or the previous one), never a partial write; and a rejected store leaves
   * nothing behind. Photo and cutout are written concurrently and the thumb
   * writer reads whichever exists (S3 gives this for free; the local backend
   * writes to a temp file and renames).
   */
  protected abstract store(fileName: string, stream: Readable): Promise<void>;

  /**
   * Transcodes the upload to the original variant and derives its thumb.
   * Returns an unpersisted File row; on failure nothing is left in storage.
   *
   * `fileName` + `deferThumb` is the photo half of a photo+cutout upload:
   * the cutout is stored concurrently under the same name, so a thumb built
   * here would come from the photo and be thrown away. The caller builds the
   * one thumb with regenerateThumb once both halves are stored.
   */
  async storeImageFromFileUpload(
    upload: MultipartFile | undefined,
    userId?: number,
    { fileName, deferThumb = false }: StoreImageOptions = {},
  ): Promise<File> {
    if (!upload) {
      throw new HttpException('No file uploaded', HttpStatus.BAD_REQUEST);
    }
    const heic = isHeicUpload(upload);
    // https://github.com/fastify/fastify-multipart/issues/497
    // Unconsumed multipart streams can hang the request; drain before throwing
    if (!heic && !upload.mimetype?.startsWith('image/')) {
      upload.file.resume();
      throw new HttpException('Wrong filetype', HttpStatus.BAD_REQUEST);
    }

    const storedFileName = fileName ?? `${randomUUID()}.webp`;
    const source = heic ? await this.decodeHeicUpload(upload) : upload.file;
    await this.transcodeUpload(
      source,
      this.imageTransformer().autoOrient(),
      storedFileName,
    );
    if (!deferThumb) {
      try {
        await this.regenerateThumb(storedFileName);
      } catch (error) {
        await this.deleteVariants(storedFileName);
        throw error;
      }
    }
    this.logger.log(`Stored upload ${storedFileName} for user ${userId}`);
    return this.newFileRow(storedFileName, userId);
  }

  /**
   * Byte-for-byte copy of the original and, when present, the cutout under a
   * fresh name, returned as an unpersisted File row. Returns undefined when
   * the source is gone from storage (the row can outlive the bytes).
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
    try {
      await this.store(newFileName, source);
      const nobgSource = await this.getIfExists(
        variantFileName(sourceFileName, 'nobg'),
      );
      if (nobgSource) {
        await this.store(variantFileName(newFileName, 'nobg'), nobgSource);
      }
      await this.regenerateThumb(newFileName);
    } catch (error) {
      await this.deleteVariants(newFileName);
      throw error;
    }
    this.logger.log(`Copied ${sourceFileName} to ${newFileName}`);
    return this.newFileRow(newFileName, userId);
  }

  /**
   * Writes the background-removed cutout for `originalFileName`.
   *
   * `newUpload`: the cutout belongs to a photo stored in the same request
   * (see storeImageFromFileUpload's deferThumb); no client has seen this
   * name yet, so there is no version to bump, and the caller builds the thumb
   * once both halves are stored.
   *
   * Otherwise (a mask edit) clients may already hold the old nobg and thumb
   * under the current version: the thumb is rewritten first and the version
   * bumped after, so no client can cache a stale thumb under the new version.
   */
  async storeNobgVariantFromStream(
    stream: Readable,
    originalFileName: string,
    { newUpload }: { newUpload: boolean },
  ): Promise<void> {
    const nobgName = variantFileName(originalFileName, 'nobg');
    await this.transcodeUpload(stream, this.imageTransformer(), nobgName);
    if (!newUpload) {
      await this.regenerateThumb(originalFileName);
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

  // The @BeforeCreate hook on ShareableId runs from the UnitOfWork on insert,
  // so the row is complete once whoever owns the transaction persists it.
  private newFileRow(fileName: string, userId: number | undefined): File {
    return this.fileRepository.create(
      {
        fileName,
        createdOn: new Date().toISOString(),
        createdBy: userId,
      },
      { persist: false },
    );
  }

  // HEIC is the one format sharp cannot read (see heic.ts). The whole part is
  // buffered, so MAX_HEIC_BYTES bounds memory per upload; the 413 from the cap
  // passes through, undecodable bytes are the client's error like any other.
  private async decodeHeicUpload(upload: MultipartFile): Promise<Readable> {
    const maxBytes = this.configService.getOrThrow<number>('MAX_HEIC_BYTES');
    const startedAt = Date.now();
    try {
      const jpeg = await decodeHeic(upload, maxBytes);
      this.logger.debug(
        `Decoded HEIC ${upload.filename} in ${Date.now() - startedAt}ms`,
      );
      return jpeg;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(
        `Rejected undecodable HEIC upload ${upload.filename}: ${String(error)}`,
      );
      throw new BadRequestException('Unreadable image');
    }
  }

  // Client bytes: an undecodable stream is the client's error, not ours.
  private async transcodeUpload(
    source: Readable,
    transformer: Sharp,
    targetFileName: string,
  ): Promise<void> {
    try {
      await this.transcode(source, transformer, targetFileName);
    } catch (error) {
      if (error instanceof UnreadableImageError) {
        this.logger.warn(`Rejected unreadable upload for ${targetFileName}`);
        throw new BadRequestException('Unreadable image');
      }
      throw error;
    }
  }

  private imageTransformer(): Sharp {
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
  // store (an S3 Upload or a file write) that the body is complete. Whichever
  // side fails first is the root cause; the other then fails from the
  // destroyed PassThrough and is only drained. A source-side failure is
  // reported as UnreadableImageError so callers can tell bad input from
  // storage trouble.
  private async transcode(
    source: Readable,
    transformer: Sharp,
    targetFileName: string,
  ): Promise<void> {
    const passThrough = new Stream.PassThrough();
    const stored = this.store(targetFileName, passThrough);
    const piped = pipeline(source, transformer, passThrough).catch(
      (error: unknown) => {
        throw new UnreadableImageError(error);
      },
    );
    try {
      await Promise.all([stored, piped]);
    } catch (error) {
      passThrough.destroy();
      await Promise.allSettled([stored, piped]);
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
