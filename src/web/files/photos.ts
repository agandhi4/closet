import type { MultipartFile } from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp, { type Sharp } from 'sharp';
import type { Config } from '../../config';
import {
  applyCutoutEvent,
  type CutoutOutcome,
  lockCutoutRow,
} from '../../cutout/queries';
import type { CutoutEvent } from '../../cutout/state';
import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import type { Logger } from '../../logger';
import { PROJECT_ROOT } from '../../project-root';
import {
  type DecodedHeic,
  decodeHeic,
  imageTooLarge,
  isHeicUpload,
} from './heic';
import {
  IMAGE_VARIANTS,
  type ImageVariant,
  variantFileName,
} from './image-variant';
import { findPhotoByShareableId, type NewPhotoRow } from './queries';
import { PhotoStorage } from './storage';

const IMAGE_MAX_PX = 1080;
const IMAGE_QUALITY = 90;
const THUMB_MAX_PX = 400;
const THUMB_QUALITY = 80;

/**
 * The decompression-bomb guard on every decode (sharp's limitInputPixels,
 * and the HEIC dimension check before its pixels are allocated). sharp's own
 * default is ~268 MP, about a gigabyte of pixels for a file of a few KB.
 * 64 MP admits every phone's full-resolution mode up to 50 MP (Pixel,
 * 8160x6144) and refuses the 200 MP modes; a refused upload is a 400.
 */
export const MAX_INPUT_PIXELS = 64_000_000;

/** A sharp pipeline that decodes at most MAX_INPUT_PIXELS; the only way Photos builds one. */
function decoder(raw?: DecodedHeic['raw']): Sharp {
  return sharp({ limitInputPixels: MAX_INPUT_PIXELS, ...(raw && { raw }) });
}

/** Pixels Photos made itself (a decoded original, a mask), under the same limit. */
function rawImage(
  pixels: Buffer,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
): Sharp {
  return sharp(pixels, {
    limitInputPixels: MAX_INPUT_PIXELS,
    raw: { width, height, channels },
  });
}

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

export interface StoreUploadOptions {
  /** Pre-chosen `<uuid>.webp`, so a cutout can be stored under it concurrently. */
  fileName?: string;
  /** The caller calls regenerateThumb after the cutout is stored too. */
  deferThumb?: boolean;
}

export interface PhotosConfig {
  /** DATA_PATH: where the photo files live. */
  dataPath: string;
  /** MAX_HEIC_BYTES: HEIC parts are buffered whole, so this bounds memory. */
  maxHeicBytes: number;
  /** Absolute path of the app icon composited onto share previews. */
  watermarkIconPath: string;
  /** WATERMARK_ENABLED: composite the icon; the resize happens regardless. */
  watermarkEnabled: boolean;
}

/** Where photos live and how share previews are made, from config. */
export function photosConfig(config: Config): PhotosConfig {
  return {
    dataPath: config.DATA_PATH,
    maxHeicBytes: config.MAX_HEIC_BYTES,
    watermarkIconPath: join(PROJECT_ROOT, 'public', 'assets', config.ICON_NAME),
    watermarkEnabled: config.WATERMARK_ENABLED,
  };
}

/**
 * Builds the one Photos instance of a process (its thumb single-flight map
 * must be shared by every caller) and prepares its directory: creates it
 * and sweeps stale partial writes. createApp() builds the server's and
 * hands it to the web layer; the reconciliation CLI builds its own.
 */
export function createPhotos(
  config: PhotosConfig,
  db: Db,
  logger: Logger,
): Photos {
  const storage = new PhotoStorage(config.dataPath, logger);
  storage.prepare();
  logger.info(`Photos stored under ${config.dataPath}`);
  return new Photos(storage, db, logger, config);
}

/**
 * Everything about a photo: variant naming, transcoding, thumbnail
 * derivation, versions, and the bytes on disk (PhotoStorage). Every photo is
 * a set of WebP files sharing one base name; only the original has a `file`
 * row (see image-variant.ts).
 *
 * Bytes are written before any row exists. storeUpload and copy return the
 * row to insert (NewPhotoRow) instead of inserting it, so the caller commits
 * it in the same transaction as the garment that references it and calls
 * deleteVariants if that transaction fails: nothing on disk is ever pointed
 * at by a half-written state. Rows are removed by their owners' transactions
 * too; deleteVariants after commit unlinks the bytes (the database cascade
 * never does, CLAUDE.md Gotchas).
 */
export class Photos {
  // Pending thumb write per original file name. Writes are chained rather
  // than deduplicated so that on a fresh upload, where the original and the
  // cutout land concurrently, the cutout's thumb always wins; lazy reads join
  // the write already in flight instead of starting a duplicate.
  private readonly thumbJobs = new Map<string, Promise<void>>();
  private watermark: Promise<Buffer> | undefined;

  constructor(
    readonly storage: PhotoStorage,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly config: Pick<
      PhotosConfig,
      'maxHeicBytes' | 'watermarkIconPath' | 'watermarkEnabled'
    >,
  ) {}

  /**
   * Transcodes the upload to the original variant and derives its thumb.
   * Returns the row to insert; on failure nothing is left in storage.
   *
   * `fileName` + `deferThumb` is the photo half of a photo+cutout upload:
   * the cutout is stored concurrently under the same name, so a thumb built
   * here would come from the photo and be thrown away. The caller builds the
   * one thumb with regenerateThumb once both halves are stored.
   */
  async storeUpload(
    upload: MultipartFile | undefined,
    userId: number,
    { fileName, deferThumb = false }: StoreUploadOptions = {},
  ): Promise<NewPhotoRow> {
    if (!upload) throw new HttpError(400, 'No file uploaded');
    const storedFileName = fileName ?? `${randomUUID()}.webp`;
    const { pixels, raw } = await this.uploadSource(upload);
    await this.transcodeUpload(
      pixels,
      this.imageTransformer(raw).autoOrient(),
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
    this.logger.info(`Stored upload ${storedFileName} for user ${userId}`);
    return newPhotoRow(storedFileName, userId);
  }

  /**
   * The garment photo form's multipart body: a `photo` part and, when the
   * browser made one, its `nobgPhoto` cutout, stored under one new name with
   * one thumb (from the cutout when there is one). Returns the row to insert
   * as storeUpload does; undefined when no photo was sent. On any failure
   * nothing is left in storage. A cutout without its photo is a 400.
   *
   * Both pipelines are started inside the `for await` loop and awaited only
   * after it: @fastify/multipart yields live streams, and a part nobody
   * reads backpressures the parser, so awaiting the photo before the cutout
   * part is consumed would hang the request. Each is armed with a no-op
   * catch where it starts (startPipeline): a rejection while later parts are
   * still being read would otherwise be an unhandled rejection that kills
   * the process. The real error still surfaces from Promise.allSettled.
   */
  async storeUploadParts(
    parts: AsyncIterable<MultipartFile>,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    const fileName = `${randomUUID()}.webp`;
    const { photo, cutout } = await this.startParts(parts, userId, fileName);
    if (!photo) {
      if (cutout) await this.refuseLoneCutout(cutout, fileName, userId);
      return undefined;
    }
    try {
      // Both must settle before cleaning up: one may still be writing under
      // the name while the other has already failed.
      const [stored, cut] = await Promise.allSettled([photo, cutout]);
      if (stored.status === 'rejected') throw stored.reason;
      if (cut.status === 'rejected') throw cut.reason;
      // The one thumb, built once both halves are stored so it reads the
      // cutout when there is one (neither pipeline builds its own).
      await this.regenerateThumb(fileName);
      return stored.value;
    } catch (error) {
      await this.deleteVariants(fileName);
      throw error;
    }
  }

  /** Starts (never awaits) a pipeline per part; see storeUploadParts. */
  private async startParts(
    parts: AsyncIterable<MultipartFile>,
    userId: number,
    fileName: string,
  ): Promise<{ photo?: Promise<NewPhotoRow>; cutout?: Promise<unknown> }> {
    const started: {
      photo?: Promise<NewPhotoRow>;
      cutout?: Promise<unknown>;
    } = {};
    for await (const part of parts) {
      if (part.fieldname === 'photo' && !started.photo) {
        started.photo = startPipeline(
          this.storeUpload(part, userId, { fileName, deferThumb: true }),
        );
      } else if (part.fieldname === 'nobgPhoto' && !started.cutout) {
        started.cutout = startPipeline(
          this.storeNewCutout(part.file, fileName),
        );
      } else {
        part.file.resume();
      }
    }
    return started;
  }

  // The cutout had to be consumed (parts arrive in the client's order), so
  // it may have written under the never-persisted name: drain it, remove
  // what it wrote, refuse.
  private async refuseLoneCutout(
    cutout: Promise<unknown>,
    fileName: string,
    userId: number,
  ): Promise<never> {
    await cutout.catch((error: unknown) =>
      this.logger.warn(`Discarded cutout failed: ${String(error)}`),
    );
    await this.deleteVariants(fileName);
    this.logger.warn(`Upload by user ${userId} had a cutout but no photo`);
    throw new HttpError(400, 'nobgPhoto requires photo');
  }

  /**
   * Byte-for-byte copy of the original and, when present, the cutout under a
   * fresh name, with a new thumb; returns the row to insert, as storeUpload
   * does. Undefined when the source is gone from storage (a row can outlive
   * its bytes).
   */
  async copy(
    sourceFileName: string,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    const source = await this.storage.get(sourceFileName);
    if (!source) {
      this.logger.warn(`Photo copy: source ${sourceFileName} is missing`);
      return undefined;
    }

    const newFileName = `${randomUUID()}.webp`;
    try {
      await this.storage.store(newFileName, source);
      const nobgSource = await this.storage.get(
        variantFileName(sourceFileName, 'nobg'),
      );
      if (nobgSource) {
        await this.storage.store(
          variantFileName(newFileName, 'nobg'),
          nobgSource,
        );
      }
      await this.regenerateThumb(newFileName);
    } catch (error) {
      await this.deleteVariants(newFileName);
      throw error;
    }
    this.logger.info(`Copied photo ${sourceFileName} to ${newFileName}`);
    return newPhotoRow(newFileName, userId);
  }

  /**
   * The cutout half of a photo+cutout upload (storeUploadParts): no client
   * has seen this name yet, so there is no version to bump and no state to
   * change, and the caller builds the one thumb once both halves are stored.
   */
  private async storeNewCutout(
    stream: Readable,
    originalFileName: string,
  ): Promise<void> {
    const nobgName = variantFileName(originalFileName, 'nobg');
    await this.transcodeUpload(stream, this.imageTransformer(), nobgName);
    this.logger.info(`Stored cutout ${nobgName}`);
  }

  /**
   * The mask editor's cutout replaces the stored one (the `edit` event: a
   * user's mask always wins, and no server job result replaces it after).
   * Returns the photo's new version; undefined when no row has that name.
   * The upload is encoded before the row is locked, so a slow client never
   * holds the lock.
   */
  async saveEditedCutout(
    stream: Readable,
    originalFileName: string,
  ): Promise<number | undefined> {
    const bytes = await this.encodeUpload(stream, this.imageTransformer());
    const outcome = await this.writeCutout(
      originalFileName,
      { type: 'edit' },
      bytes,
    );
    if (!outcome.ok) {
      this.logger.warn(
        `Edited cutout for ${originalFileName} not stored: ${outcome.reason}`,
      );
      return undefined;
    }
    return outcome.state.version;
  }

  /**
   * The server model's input for a stored photo: the original as stored
   * (1080 px, already decoded, HEIC included) stretched to `size` x `size`
   * RGB, 3 bytes a pixel. Stretched rather than padded, as the model's own
   * preprocessing and the benchmark did; saveModelCutout stretches the mask
   * back. A 404 HttpError when the original is gone.
   */
  async cutoutInput(fileName: string, size: number): Promise<Buffer> {
    const source = await this.getOrNotFound(fileName);
    const transformer = decoder()
      .removeAlpha()
      .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
      .raw();
    source.on('error', (error) => transformer.destroy(error));
    return source.pipe(transformer).toBuffer();
  }

  /**
   * A server job's result (the queue, src/cutout/queue.ts): `mask`, a
   * `maskSize` square of 0-255 alpha from the model, becomes the photo's
   * cutout, stored only while the state machine accepts `succeed` for the
   * photo version the job started for (never over an edit or a replaced
   * photo). The outcome says which.
   */
  async saveModelCutout(
    fileName: string,
    mask: Buffer,
    maskSize: number,
    jobVersion: number,
  ): Promise<CutoutOutcome> {
    const bytes = await this.composeCutout(fileName, mask, maskSize);
    return this.writeCutout(fileName, { type: 'succeed', jobVersion }, bytes);
  }

  // The original's pixels with the mask, stretched back to their size, as
  // alpha, centred on a transparent square: the shape of every
  // browser-made cutout, which the mask editor (it pads the original the
  // same way to paint it back) and the square tiles rely on.
  private async composeCutout(
    fileName: string,
    mask: Buffer,
    maskSize: number,
  ): Promise<Buffer> {
    const source = await this.getOrNotFound(fileName);
    const decode = decoder().removeAlpha().raw();
    source.on('error', (error) => decode.destroy(error));
    const { data: rgb, info } = await source
      .pipe(decode)
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const alpha = await rawImage(mask, maskSize, maskSize, 1)
      .resize(width, height, { fit: 'fill' })
      // Without it sharp emits a single-channel input as 3-channel sRGB.
      .extractChannel(0)
      .raw()
      .toBuffer();
    // Joined, then read back, before extend(): sharp orders a pipeline's
    // operations itself, and a channel join must not run after the padding.
    const rgba = await rawImage(rgb, width, height, 3)
      .joinChannel(alpha, { raw: { width, height, channels: 1 } })
      .raw()
      .toBuffer();
    const side = Math.max(width, height);
    const left = Math.floor((side - width) / 2);
    const top = Math.floor((side - height) / 2);
    return rawImage(rgba, width, height, 4)
      .extend({
        left,
        right: side - width - left,
        top,
        bottom: side - height - top,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: IMAGE_QUALITY })
      .toBuffer();
  }

  /**
   * Writes cutout bytes under the photo's row lock, only if the state
   * machine accepts `event` (src/cutout/state.ts): the nobg file, then the
   * thumb, then the row with its new version, so no client can cache a
   * stale thumb under the new version. Every writer of an existing photo's
   * cutout (the mask editor, the server job) comes through here, so the
   * lock orders them and a refused one writes no bytes: a job result never
   * lands on a user's edit or on a replaced photo.
   */
  private writeCutout(
    originalFileName: string,
    event: CutoutEvent,
    bytes: Buffer,
  ): Promise<CutoutOutcome> {
    const nobgName = variantFileName(originalFileName, 'nobg');
    return this.db.transaction(async (tx) => {
      const row = await lockCutoutRow(tx, originalFileName);
      if (!row) return { ok: false, reason: 'gone' } as const;
      const outcome = await applyCutoutEvent(tx, row, event, async () => {
        await this.storage.store(nobgName, Readable.from(bytes));
        await this.regenerateThumb(originalFileName);
      });
      if (outcome.ok) {
        this.logger.info(
          `Cutout ${nobgName} stored (${event.type}): ${row.status} -> ${outcome.state.status}, version ${outcome.state.version}`,
        );
      }
      return outcome;
    });
  }

  /**
   * Streams a variant, falling back gracefully: a missing cutout serves the
   * original, a missing thumb is generated on first request (backfill for
   * photos stored before thumbs existed). A 404 HttpError only when the
   * original itself is gone.
   */
  async getVariant(fileName: string, variant: ImageVariant): Promise<Readable> {
    switch (variant) {
      case 'original':
        return this.getOrNotFound(fileName);
      case 'nobg':
        return (
          (await this.storage.get(variantFileName(fileName, 'nobg'))) ??
          this.getOrNotFound(fileName)
        );
      case 'thumb': {
        const thumbName = variantFileName(fileName, 'thumb');
        const existing = await this.storage.get(thumbName);
        if (existing) return existing;
        await (this.thumbJobs.get(fileName) ?? this.regenerateThumb(fileName));
        return this.getOrNotFound(thumbName);
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

  /** Removes every variant; a failure is logged, never thrown. */
  async deleteVariants(fileName: string): Promise<void> {
    for (const variant of IMAGE_VARIANTS) {
      const name = variantFileName(fileName, variant);
      await this.storage
        .delete(name)
        .catch((error: unknown) =>
          this.logger.warn(`Failed to delete ${name}: ${String(error)}`),
        );
    }
    this.logger.info(`Deleted variants of ${fileName}`);
  }

  /**
   * The share-preview image of the photo behind `shareableId`: the original
   * as a JPEG within 1080px, with the app icon composited when
   * WATERMARK_ENABLED. A 404 HttpError when there is no such photo.
   */
  async watermarked(shareableId: string): Promise<Readable> {
    const fileName = await findPhotoByShareableId(this.db, shareableId);
    if (!fileName) throw new HttpError(404);
    const transformer = decoder()
      .jpeg()
      .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, { fit: sharp.fit.inside });
    if (this.config.watermarkEnabled) {
      transformer.composite([
        { input: await this.watermarkIcon(), gravity: 'southwest' },
      ]);
    }
    const source = await this.getOrNotFound(fileName);
    // pipe() does not forward a source failure; the reply streams the
    // transformer, so it must fail with it.
    source.on('error', (error) => transformer.destroy(error));
    return source.pipe(transformer);
  }

  // Built once: the icon does not change while the process runs.
  private watermarkIcon(): Promise<Buffer> {
    this.watermark ??= sharp(this.config.watermarkIconPath, {
      limitInputPixels: MAX_INPUT_PIXELS,
    })
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
          raw: { width: 1, height: 1, channels: 4 },
          tile: true,
          blend: 'dest-in',
        },
      ])
      .toBuffer();
    return this.watermark;
  }

  private async getOrNotFound(fileName: string): Promise<Readable> {
    const stream = await this.storage.get(fileName);
    if (!stream) throw new HttpError(404);
    return stream;
  }

  // The part's bytes in a form sharp reads: the encoded stream itself, or
  // a HEIC's decoded pixels with their layout.
  private async uploadSource(
    upload: MultipartFile,
  ): Promise<{ pixels: Readable; raw?: DecodedHeic['raw'] }> {
    if (isHeicUpload(upload)) return this.decodeHeicUpload(upload);
    if (!upload.mimetype?.startsWith('image/')) {
      // https://github.com/fastify/fastify-multipart/issues/497
      // An unconsumed multipart stream hangs the request: drain, then refuse.
      upload.file.resume();
      throw new HttpError(400, 'Wrong filetype');
    }
    return { pixels: upload.file };
  }

  // HEIC is the one format sharp cannot read (see heic.ts). The whole part is
  // buffered, so MAX_HEIC_BYTES bounds memory per upload; the 413 from the cap
  // passes through, as does the 400 for too many pixels; undecodable bytes
  // are the client's error like any other.
  private async decodeHeicUpload(upload: MultipartFile): Promise<DecodedHeic> {
    const startedAt = Date.now();
    try {
      const decoded = await decodeHeic(
        upload,
        this.config.maxHeicBytes,
        MAX_INPUT_PIXELS,
      );
      this.logger.debug(
        `Decoded HEIC ${upload.filename} (${decoded.raw.width}x${decoded.raw.height}) in ${Date.now() - startedAt}ms`,
      );
      return decoded;
    } catch (error) {
      if (error instanceof HttpError) {
        this.logger.warn(
          `Rejected HEIC upload ${upload.filename}: ${error.message}`,
        );
        throw error;
      }
      this.logger.warn(
        `Rejected undecodable HEIC upload ${upload.filename}: ${String(error)}`,
      );
      throw new HttpError(400, 'Unreadable image');
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
        this.logger.warn(
          `Rejected unreadable upload for ${targetFileName}: ${String(error.cause)}`,
        );
        throw exceedsPixelLimit(error.cause)
          ? imageTooLarge()
          : new HttpError(400, 'Unreadable image');
      }
      throw error;
    }
  }

  // Client bytes into memory rather than storage: an undecodable stream is
  // the client's error (400), as in transcodeUpload.
  private async encodeUpload(
    source: Readable,
    transformer: Sharp,
  ): Promise<Buffer> {
    // pipe() does not forward a source failure; toBuffer() must see it.
    source.on('error', (error) => transformer.destroy(error));
    try {
      return await source.pipe(transformer).toBuffer();
    } catch (error) {
      this.logger.warn(`Rejected unreadable upload: ${String(error)}`);
      throw exceedsPixelLimit(error)
        ? imageTooLarge()
        : new HttpError(400, 'Unreadable image');
    }
  }

  private imageTransformer(raw?: DecodedHeic['raw']): Sharp {
    return decoder(raw)
      .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, {
        fit: sharp.fit.inside,
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_QUALITY });
  }

  private async writeThumb(fileName: string): Promise<void> {
    const source =
      (await this.storage.get(variantFileName(fileName, 'nobg'))) ??
      (await this.getOrNotFound(fileName));
    const thumbName = variantFileName(fileName, 'thumb');
    const startedAt = Date.now();
    await this.transcode(
      source,
      decoder()
        .resize(THUMB_MAX_PX, THUMB_MAX_PX, {
          fit: sharp.fit.inside,
          withoutEnlargement: true,
        })
        .webp({ quality: THUMB_QUALITY }),
      thumbName,
    );
    this.logger.debug(`Wrote ${thumbName} in ${Date.now() - startedAt}ms`);
  }

  // Runs the source through sharp into storage. Both sides are awaited
  // together: pipeline() ending the PassThrough is what tells the store that
  // the body is complete. Whichever side fails first is the root cause; the
  // other then fails from the destroyed PassThrough and is only drained. A
  // source-side failure is reported as UnreadableImageError so callers can
  // tell bad input from storage trouble.
  private async transcode(
    source: Readable,
    transformer: Sharp,
    targetFileName: string,
  ): Promise<void> {
    const passThrough = new PassThrough();
    const stored = this.storage.store(targetFileName, passThrough);
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
}

// sharp reports limitInputPixels only through its message ("Input image
// exceeds pixel limit"); the header is read before any pixel, so this is
// the refusal, not a failed decode.
function exceedsPixelLimit(cause: unknown): boolean {
  return cause instanceof Error && /exceeds pixel limit/i.test(cause.message);
}

/**
 * Arms a pipeline started inside a multipart `for await` loop: a rejection
 * while the loop still reads later parts is then never unhandled (which
 * would exit the process). The same promise is returned, so the error still
 * reaches whoever settles it (storeUploadParts). Node's default of crashing
 * on an unhandled rejection is kept on purpose: no process-level handler.
 */
function startPipeline<T>(pipeline: Promise<T>): Promise<T> {
  pipeline.catch(() => undefined);
  return pipeline;
}

function newPhotoRow(fileName: string, userId: number): NewPhotoRow {
  return {
    fileName,
    shareableId: randomUUID(),
    createdOn: new Date().toISOString(),
    createdById: userId,
  };
}
