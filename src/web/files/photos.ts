import type { MultipartFile } from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import type { Config } from '../../config';
import {
  applyCutoutEvent,
  type CutoutOutcome,
  type CutoutRow,
  lockCutoutRow,
} from '../../cutout/queries';
import type { CutoutEvent, Transition } from '../../cutout/state';
import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import type { Logger } from '../../logger';
import { PROJECT_ROOT } from '../../project-root';
import {
  type DecodedHeic,
  decodeHeic,
  heicPixelCount,
  imageTooLarge,
  isHeicUpload,
} from './heic';
import type { SignablePhotoRef } from './image-url';
import {
  type ImageVariant,
  newVariantKey,
  parseStoredName,
  type StoredPhoto,
  unkeyedPhoto,
  variantFileName,
} from './image-variant';
import {
  findPhotoByShareableId,
  findVariantKey,
  readPhotoRef,
  type NewPhotoRow,
} from './queries';
import { PhotoStorage } from './storage';

const IMAGE_MAX_PX = 1080;
const IMAGE_QUALITY = 90;
const THUMB_MAX_PX = 400;
const THUMB_QUALITY = 80;
// Link import's photo choices (preview): small enough that six inline as
// data: URLs keep the page light.
const PREVIEW_MAX_PX = 240;
const PREVIEW_QUALITY = 70;
// openCurrentCutout: each retry follows a swap that landed meanwhile; a
// photo swapped this often during one copy is copied without its cutout.
const MAX_CUTOUT_READS = 3;

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
 * Image bytes from wherever Photos takes them: an upload's multipart part
 * (storeUpload), the seed's generated art (src/seed/), a fetched product
 * photo (link import, #6).
 */
export interface ImageSource {
  stream: Readable;
  mimetype: string;
  /** As the sender named it: for logs, and the HEIC hint (isHeicUpload). */
  filename: string;
}

export interface StoreImageOptions {
  /**
   * The image's transparency is already its cutout (art drawn on a
   * transparent background, the seed's): the original is stored flattened
   * on white, as a photo of the garment would be, and the cutout is the art
   * as drawn, padded square like every cutout; the thumb derives from it.
   * The caller inserts the row as a finished cutout,
   * initialCutoutState('ready'), rather than queueing it.
   */
  alphaIsCutout?: boolean;
  /**
   * Clockwise degrees to turn the image after its EXIF orientation is
   * applied: rotateStored's copy of a stored original.
   */
  rotate?: QuarterTurn;
}

/** A garment photo's rotation (POST /wardrobe/:id/photo/rotate), clockwise degrees. */
export type QuarterTurn = 90 | 270;

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
 * Bytes are written before any row exists. storeImage and copy return the
 * row to insert (NewPhotoRow) instead of inserting it, so the caller commits
 * it in the same transaction as the garment that references it and calls
 * deleteVariants if that transaction fails: nothing on disk is ever pointed
 * at by a half-written state. Rows are removed by their owners' transactions
 * too; deleteVariants after commit unlinks the bytes (the database cascade
 * never does, CLAUDE.md Gotchas).
 */
export class Photos {
  // Pending thumb write per thumb file name. Writes are chained rather than
  // deduplicated so that one started later always lands last; lazy reads
  // join the write already in flight instead of starting a duplicate. A
  // cutout's keyed thumb (writeCutout) is a new name no other write meets.
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

  /** storeImage for a multipart part; a 400 without one. */
  storeUpload(
    upload: MultipartFile | undefined,
    userId: number,
  ): Promise<NewPhotoRow> {
    if (!upload) throw new HttpError(400, 'No file uploaded');
    return this.storeImage(
      {
        stream: upload.file,
        mimetype: upload.mimetype,
        filename: upload.filename,
      },
      userId,
    );
  }

  /**
   * Transcodes the image to the original variant (1080 px, WebP, the decode
   * bound and HEIC included) and derives its thumb; with `alphaIsCutout`
   * the cutout too. Returns the row to insert; on failure nothing is left in
   * storage. Bytes that are not an image are the sender's error: a 400.
   */
  async storeImage(
    source: ImageSource,
    userId: number,
    options: StoreImageOptions = {},
  ): Promise<NewPhotoRow> {
    const fileName = `${randomUUID()}.webp`;
    const { pixels, raw } = await this.imageSource(source);
    // Every path honours EXIF orientation, the art's included (#199: a
    // sideways cutout upload stayed sideways). HEIC arrives decoded and
    // rotated already, with no EXIF left, so it is a no-op there.
    const oriented = decoder(raw).autoOrient();
    if (options.rotate) oriented.rotate(options.rotate);
    const art = options.alphaIsCutout
      ? await this.decodeUpload(
          pixels,
          oriented
            .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, {
              fit: sharp.fit.inside,
              withoutEnlargement: true,
            })
            .ensureAlpha()
            .raw(),
        )
      : undefined;
    if (!art) {
      await this.transcodeUpload(
        pixels,
        originalTransformer(oriented),
        fileName,
      );
    }
    try {
      if (art) await this.storeArtwork(art, fileName);
      await this.regenerateThumb(unkeyedPhoto(fileName));
    } catch (error) {
      await this.deleteVariants(unkeyedPhoto(fileName));
      throw error;
    }
    this.logger.info(
      `Stored ${source.filename} as ${fileName} for user ${userId}${options.alphaIsCutout ? ' (its own cutout)' : ''}`,
    );
    return newPhotoRow(fileName, userId);
  }

  /**
   * The row to insert for a photo whose bytes are already stored but which
   * has no row yet: a pending photo (a link import's fetch, an add-sheet
   * upload), held until its garment form is saved
   * (createGarmentWithPendingPhoto, src/web/wardrobe/writes.ts).
   * Undefined when `fileName` is not a stored original's name or its bytes
   * are gone (reconciliation removes such photos after a day). Whether a
   * row already exists is the caller's check, under its lock.
   */
  async pendingPhotoRow(
    fileName: string,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    if (parseStoredName(fileName)?.variant !== 'original') return undefined;
    if (!(await this.storage.exists(fileName))) return undefined;
    return newPhotoRow(fileName, userId);
  }

  /**
   * A small WebP of an image that is not stored: link import's photo
   * choices, shown inline as data: URLs before one is picked. The CSP
   * allows no other origin's images, and the choices must not be stored:
   * every unpicked one would be an orphan counting against reconciliation's
   * deletion guard. The same decode bound and HEIC path as a stored photo;
   * unreadable bytes are a 400 HttpError.
   */
  async preview(source: ImageSource): Promise<Buffer> {
    const { pixels, raw } = await this.imageSource(source);
    return this.encodeUpload(
      pixels,
      decoder(raw)
        .autoOrient()
        .resize(PREVIEW_MAX_PX, PREVIEW_MAX_PX, {
          fit: sharp.fit.inside,
          withoutEnlargement: true,
        })
        .webp({ quality: PREVIEW_QUALITY }),
    );
  }

  /**
   * How many pixels decoding the image would take, read from its header (a
   * HEIC's container) without decoding any: for a caller that budgets
   * several decodes (link import's choices). The same refusals as a
   * decode: 400 for bytes that are not an image, 400 "Image too large" past
   * MAX_INPUT_PIXELS. Consumes the stream.
   */
  async inputPixels(source: ImageSource): Promise<number> {
    let pixels: number;
    try {
      pixels = isHeicUpload(source)
        ? await heicPixelCount(source.stream, this.config.maxHeicBytes)
        : await this.headerPixels(source);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      this.logger.warn(
        `Rejected unreadable image ${source.filename}: ${String(error)}`,
      );
      throw exceedsPixelLimit(error)
        ? imageTooLarge()
        : new HttpError(400, 'Unreadable image');
    }
    if (pixels > MAX_INPUT_PIXELS) throw imageTooLarge();
    return pixels;
  }

  /**
   * The garment photo form's multipart body: its `photo` part, stored as
   * storeUpload does; undefined when no photo was sent. Every other part is
   * drained unread, notably `nobgPhoto`: pages an installed PWA cached
   * before background removal moved to the server still post the browser's
   * cutout, and the server makes its own.
   *
   * The photo's pipeline is started inside the `for await` loop and awaited
   * only after it: @fastify/multipart yields live streams, and a part nobody
   * reads backpressures the parser. It is armed with a no-op catch where it
   * starts (startPipeline): a rejection while later parts are still being
   * read would otherwise be an unhandled rejection that kills the process.
   * The real error still surfaces from the caller's await.
   */
  async storeUploadParts(
    parts: AsyncIterable<MultipartFile>,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    let photo: Promise<NewPhotoRow> | undefined;
    for await (const part of parts) {
      if (part.fieldname === 'photo' && !photo) {
        photo = startPipeline(this.storeUpload(part, userId));
        continue;
      }
      if (part.fieldname === 'nobgPhoto') {
        this.logger.info(
          `Upload by user ${userId}: ignored the browser's cutout (a page cached before server-side removal)`,
        );
      }
      part.file.resume();
    }
    return photo;
  }

  /**
   * Byte-for-byte copy of the original and, when present, the cutout the
   * source's row points at, under a fresh name (unkeyed: the copy has no
   * row yet), with a new thumb; returns the row to insert, as storeUpload
   * does. Undefined when the source is gone from storage (a row can outlive
   * its bytes). `source` is the photo as the caller read its row (the
   * clone's garment): its variant key is the cutout's first guess, read
   * again only when a swap moved it meanwhile.
   */
  async copy(
    source: StoredPhoto,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    const sourceFileName = source.fileName;
    const original = await this.storage.get(sourceFileName);
    if (!original) {
      this.logger.warn(`Photo copy: source ${sourceFileName} is missing`);
      return undefined;
    }

    const copied = unkeyedPhoto(`${randomUUID()}.webp`);
    try {
      await this.storage.store(copied.fileName, original);
      const nobgSource = await this.openCurrentCutout(
        sourceFileName,
        source.variantKey,
      );
      if (nobgSource) {
        await this.storage.store(
          variantFileName(copied.fileName, 'nobg'),
          nobgSource,
        );
      }
      await this.regenerateThumb(copied);
    } catch (error) {
      await this.deleteVariants(copied);
      throw error;
    }
    this.logger.info(`Copied photo ${sourceFileName} to ${copied.fileName}`);
    return newPhotoRow(copied.fileName, userId);
  }

  /**
   * A stored photo turned by `turn` as a new photo (the rotate button,
   * rotateGarmentPhoto): the original's bytes through storeImage, so the
   * source's files are never touched, and with `withCutout` the cutout
   * the source's row points at, turned the same way (a mask edit
   * survives: the cutout is a padded square, so turning it is what cutting
   * out the turned original gives). Returns the row to insert, as
   * storeImage does, and whether the cutout came along: false when the
   * source had none on disk (then it needs a new one). A 404 when the
   * original is gone.
   */
  async rotateStored(
    sourceFileName: string,
    turn: QuarterTurn,
    userId: number,
    withCutout: boolean,
  ): Promise<{ row: NewPhotoRow; cutoutKept: boolean }> {
    const row = await this.storeImage(
      {
        stream: await this.getOrNotFound(sourceFileName),
        mimetype: 'image/webp',
        filename: sourceFileName,
      },
      userId,
      { rotate: turn },
    );
    if (!withCutout) return { row, cutoutKept: false };

    const rotated = unkeyedPhoto(row.fileName);
    try {
      const cutout = await this.openCurrentCutout(sourceFileName);
      if (!cutout) {
        this.logger.warn(
          `Rotating ${sourceFileName}: its cutout is missing; ${row.fileName} will need a new one`,
        );
        return { row, cutoutKept: false };
      }
      await this.transcode(
        cutout,
        decoder().rotate(turn).webp({ quality: IMAGE_QUALITY }),
        variantFileName(row.fileName, 'nobg'),
      );
      // storeImage made the thumb from the original; a cutout's comes from it.
      await this.regenerateThumb(rotated);
    } catch (error) {
      await this.deleteVariants(rotated);
      throw error;
    }
    this.logger.info(
      `Rotated ${sourceFileName} by ${turn}° as ${row.fileName}, its cutout with it`,
    );
    return { row, cutoutKept: true };
  }

  // The cutout the row points at, opened (an open file streams whole even
  // when it is deleted after); undefined when the photo has none. A swap
  // between reading the key and opening its file deletes the set it
  // replaced, so a missing file under a key the row no longer names is
  // read again under the new one: a copy (a clone keeps the source's
  // ready or edited status) must not lose the cutout to that race. A
  // caller that read the row already passes its key (`known`), sparing
  // the first read.
  private async openCurrentCutout(
    fileName: string,
    known?: string | null,
  ): Promise<Readable | undefined> {
    let key =
      known === undefined
        ? ((await findVariantKey(this.db, fileName)) ?? null)
        : known;
    for (let attempt = 1; ; attempt++) {
      const opened = await this.storage.get(
        variantFileName(fileName, 'nobg', key),
      );
      if (opened || attempt === MAX_CUTOUT_READS) return opened;
      const current = (await findVariantKey(this.db, fileName)) ?? null;
      if (current === key) return undefined;
      this.logger.info(
        `Cutout of ${fileName} swapped from ${key ?? 'unkeyed'} to ${current ?? 'unkeyed'} while it was read; reading again`,
      );
      key = current;
    }
  }

  /**
   * The mask editor's cutout replaces the stored one (the `edit` event: a
   * user's mask always wins, and no server job result replaces it after).
   * Returns the photo as its URLs now name it (the new version and variant
   * key: the editor's next image and edit read those); undefined when no
   * row has that name. The upload is encoded and stored before the row is
   * locked, so neither a slow client nor slow storage ever holds the lock.
   */
  async saveEditedCutout(
    stream: Readable,
    originalFileName: string,
  ): Promise<SignablePhotoRef | undefined> {
    const bytes = await this.encodeUpload(
      stream,
      originalTransformer(decoder()),
    );
    const outcome = await this.writeCutout(
      originalFileName,
      (variantKey) => ({ type: 'edit', variantKey }),
      bytes,
    );
    if (!outcome.ok) {
      this.logger.warn(
        `Edited cutout for ${originalFileName} not stored: ${outcome.reason}`,
      );
      return undefined;
    }
    const { version, variantKey } = outcome.state;
    // A garment's photo: the mask editor edits only those (never a selfie,
    // `unwanted`, which the machine refuses an edit).
    return readPhotoRef({ fileName: originalFileName, version, variantKey });
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
    return this.writeCutout(
      fileName,
      (variantKey) => ({ type: 'succeed', jobVersion, variantKey }),
      bytes,
    );
  }

  // The original's pixels with the mask, stretched back to their size, as
  // alpha, centred on a transparent square (squareCutout).
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
    return squareCutout(rgba, width, height);
  }

  // storeImage's alphaIsCutout: the original is the art on white (the share
  // preview is a JPEG of the original and the mask editor paints it back,
  // so neither may meet transparency), the cutout is the art's own alpha,
  // padded as composeCutout pads the model's.
  private async storeArtwork(
    { data, info }: { data: Buffer; info: OutputInfo },
    fileName: string,
  ): Promise<void> {
    const original = await rawImage(data, info.width, info.height, 4)
      .flatten({ background: '#ffffff' })
      .webp({ quality: IMAGE_QUALITY })
      .toBuffer();
    await this.storage.store(fileName, Readable.from(original));
    await this.storage.store(
      variantFileName(fileName, 'nobg'),
      Readable.from(await squareCutout(data, info.width, info.height)),
    );
  }

  /**
   * Stores cutout bytes for an existing photo and points its row at them,
   * only if the state machine accepts the event (src/cutout/state.ts).
   * Every writer of an existing photo's cutout (the mask editor, the server
   * job) comes through here.
   *
   * The nobg and its thumb are written first, under a fresh variant key and
   * outside any transaction; the transaction only locks the row, asks the
   * machine and swaps `variant_key` with the version (#141). Storage I/O
   * under the row lock ran into the server pool's idle-in-transaction limit
   * on a slow NFS mount, and a file renamed over the served name before a
   * COMMIT that then failed left new bytes live under the old row. Until
   * the swap commits nothing points at the new files, so a reader sees the
   * old set or the new one whole, and the thumb a new version names exists
   * before the version does. A refused event (a late job result over a
   * user's mask, a replaced photo) or a rolled-back swap leaves its files
   * unreferenced, and they are deleted here; so is the set a swap replaced,
   * after its commit.
   */
  private async writeCutout(
    originalFileName: string,
    eventFor: (variantKey: string) => CutoutEvent,
    bytes: Buffer,
  ): Promise<CutoutOutcome> {
    const variantKey = newVariantKey();
    const written: StoredPhoto = { fileName: originalFileName, variantKey };
    const event = eventFor(variantKey);
    await this.storeCutoutFiles(written, bytes);

    // What the transaction decided: settleFailedSwap needs it when the
    // COMMIT landed but its answer was lost.
    let decided: Swap | undefined;
    let swap: Swap | 'gone';
    try {
      swap = await this.db.transaction(async (tx) => {
        const before = await lockCutoutRow(tx, originalFileName);
        if (!before) return 'gone' as const;
        decided = {
          before,
          outcome: await applyCutoutEvent(tx, before, event),
        };
        return decided;
      });
    } catch (error) {
      return this.settleFailedSwap(written, event, decided, error);
    }

    if (swap === 'gone') {
      await this.deleteCutoutFiles(written, 'its photo row is gone');
      return { ok: false, reason: 'gone' };
    }
    const { before, outcome } = swap;
    if (!outcome.ok) {
      await this.deleteCutoutFiles(
        written,
        `${event.type} refused (${outcome.reason})`,
      );
      return outcome;
    }
    this.logger.info(
      `Cutout of ${originalFileName} stored (${event.type}) under key ${variantKey}: ${before.status} -> ${outcome.state.status}, version ${outcome.state.version}`,
    );
    await this.deleteReplacedCutout(before, variantKey);
    return outcome;
  }

  // After a committed swap: the set it replaced (the row's key before it).
  private deleteReplacedCutout(
    before: CutoutRow,
    newKey: string | null,
  ): Promise<void> {
    return this.deleteCutoutFiles(
      { fileName: before.fileName, variantKey: before.variantKey },
      `replaced by key ${newKey}`,
    );
  }

  // The nobg and its thumb under `written`'s key, the thumb made from the
  // bytes in hand; neither is left behind if either fails.
  private async storeCutoutFiles(
    written: StoredPhoto,
    bytes: Buffer,
  ): Promise<void> {
    const { fileName, variantKey } = written;
    try {
      await this.storage.store(
        variantFileName(fileName, 'nobg', variantKey),
        Readable.from(bytes),
      );
      await this.transcode(
        Readable.from(bytes),
        thumbTransformer(),
        variantFileName(fileName, 'thumb', variantKey),
      );
    } catch (error) {
      await this.deleteCutoutFiles(
        written,
        `storing them failed (${String(error)})`,
      );
      throw error;
    }
  }

  // The swap's transaction threw: a lock or statement timeout, the
  // idle-in-transaction limit, a dropped connection. Usually it rolled back
  // and the new files are orphans. But when the failure was COMMIT's lost
  // answer the swap may have landed, so the row is asked before its files
  // go, and a swap that landed is the outcome after all. When the row
  // cannot be read either, the files stay (an unreferenced keyed file is
  // reconciliation's, a day later) rather than risk a row pointing at
  // nothing.
  private async settleFailedSwap(
    written: StoredPhoto,
    event: CutoutEvent,
    decided: Swap | undefined,
    error: unknown,
  ): Promise<CutoutOutcome> {
    const { fileName, variantKey } = written;
    let current: string | null | undefined;
    try {
      current = await findVariantKey(this.db, fileName);
    } catch (lookupError) {
      this.logger.error(
        { err: error },
        `Cutout of ${fileName} (${event.type}): the swap to key ${variantKey} failed and the row cannot be read (${String(lookupError)}); its files are left to reconciliation`,
      );
      throw error;
    }
    // Structured: a driver error's reason is often only in its `cause`
    // (drizzle's "Failed query: commit").
    // Keys are unique per write: the row naming this one means this swap
    // committed and none has moved it since, so the set it replaced is
    // still this write's to delete, as on the normal path.
    if (current === variantKey && decided?.outcome.ok) {
      this.logger.warn(
        { err: error },
        `Cutout of ${fileName} (${event.type}): the swap to key ${variantKey} committed although its transaction failed; version ${decided.outcome.state.version}`,
      );
      await this.deleteReplacedCutout(decided.before, variantKey);
      return decided.outcome;
    }
    // current !== variantKey. Even if this swap had committed after all, a
    // second swap that has moved the key since already deleted this set as
    // the one it replaced, so deleting it again is expected: deleteFiles
    // takes a missing file as done.
    this.logger.warn(
      { err: error },
      `Cutout of ${fileName} (${event.type}): the swap to key ${variantKey} rolled back`,
    );
    await this.deleteCutoutFiles(written, 'its swap rolled back');
    throw error;
  }

  // A nobg and thumb that nothing points at (any more). Never throws: a
  // file left behind is reconciliation's (a superseded variant, a day on).
  private async deleteCutoutFiles(
    set: StoredPhoto,
    why: string,
  ): Promise<void> {
    const names = [
      variantFileName(set.fileName, 'nobg', set.variantKey),
      variantFileName(set.fileName, 'thumb', set.variantKey),
    ];
    await this.deleteFiles(names);
    this.logger.info(`Deleted ${names.join(' and ')}: ${why}`);
  }

  /**
   * Streams a variant of the set the photo's row points at, falling back
   * gracefully: a missing cutout serves the original, a missing thumb is
   * generated on first request (backfill for photos stored before thumbs
   * existed). A 404 HttpError only when the original itself is gone.
   */
  async getVariant(
    photo: StoredPhoto,
    variant: ImageVariant,
  ): Promise<Readable> {
    const { fileName, variantKey } = photo;
    switch (variant) {
      case 'original':
        return this.getOrNotFound(fileName);
      case 'nobg':
        return (
          (await this.storage.get(
            variantFileName(fileName, 'nobg', variantKey),
          )) ?? this.getOrNotFound(fileName)
        );
      case 'thumb': {
        const thumbName = variantFileName(fileName, 'thumb', variantKey);
        const existing = await this.storage.get(thumbName);
        if (existing) return existing;
        await (this.thumbJobs.get(thumbName) ?? this.regenerateThumb(photo));
        return this.getOrNotFound(thumbName);
      }
    }
  }

  /**
   * The variant's file of exactly this set, as stored; undefined when it is
   * not on disk. No fallback and no thumb made: the /file routes' signed
   * path (a URL naming this set), which answers a miss through the row and
   * getVariant. Making a thumb here could write one under a key a swap has
   * since retired, from the original, beside no cutout.
   */
  openStoredVariant(
    photo: StoredPhoto,
    variant: ImageVariant,
  ): Promise<Readable | undefined> {
    return this.storage.get(
      variantFileName(photo.fileName, variant, photo.variantKey),
    );
  }

  /** Rewrites the set's thumb from its cutout if present, else from the original. */
  regenerateThumb(photo: StoredPhoto): Promise<void> {
    const thumbName = variantFileName(
      photo.fileName,
      'thumb',
      photo.variantKey,
    );
    const previous = this.thumbJobs.get(thumbName) ?? Promise.resolve();
    const job = previous
      .catch(() => undefined)
      .then(() => this.writeThumb(photo, thumbName))
      .finally(() => {
        if (this.thumbJobs.get(thumbName) === job) {
          this.thumbJobs.delete(thumbName);
        }
      });
    this.thumbJobs.set(thumbName, job);
    return job;
  }

  /**
   * Removes every file of the photo: the original, the nobg and thumb its
   * row points at, and the unkeyed ones (a thumb backfilled for a request
   * that raced a cutout's swap can land beside a keyed set). A failure is
   * logged, never thrown.
   */
  async deleteVariants(photo: StoredPhoto): Promise<void> {
    const { fileName, variantKey } = photo;
    await this.deleteFiles([
      fileName,
      variantFileName(fileName, 'nobg'),
      variantFileName(fileName, 'thumb'),
      ...(variantKey === null
        ? []
        : [
            variantFileName(fileName, 'nobg', variantKey),
            variantFileName(fileName, 'thumb', variantKey),
          ]),
    ]);
    this.logger.info(
      `Deleted variants of ${fileName}${variantKey === null ? '' : ` (key ${variantKey})`}`,
    );
  }

  /**
   * Deletes stored files by name (reconciliation's findings: every file of
   * an orphaned photo, a superseded variant). A missing file is not an
   * error; a failure is logged, never thrown.
   */
  async deleteFiles(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await this.storage
        .delete(name)
        .catch((error: unknown) =>
          this.logger.warn(`Failed to delete ${name}: ${String(error)}`),
        );
    }
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

  // The source's bytes in a form sharp reads: the encoded stream itself, or
  // a HEIC's decoded pixels with their layout.
  private async imageSource(
    source: ImageSource,
  ): Promise<{ pixels: Readable; raw?: DecodedHeic['raw'] }> {
    if (isHeicUpload(source)) return this.decodeHeicSource(source);
    refuseNonImage(source);
    return { pixels: source.stream };
  }

  // sharp's metadata: the header only, which limitInputPixels does not
  // check (inputPixels does). Every pixel count but a HEIC's.
  private async headerPixels(source: ImageSource): Promise<number> {
    refuseNonImage(source);
    const transformer = decoder();
    source.stream.on('error', (error) => transformer.destroy(error));
    const { width, height } = await source.stream.pipe(transformer).metadata();
    if (!width || !height) throw new Error('No dimensions in the header');
    return width * height;
  }

  // HEIC is the one format sharp cannot read (see heic.ts). The whole part is
  // buffered, so MAX_HEIC_BYTES bounds memory per upload; the 413 from the cap
  // passes through, as does the 400 for too many pixels; undecodable bytes
  // are the client's error like any other.
  private async decodeHeicSource(source: ImageSource): Promise<DecodedHeic> {
    const startedAt = Date.now();
    try {
      const decoded = await decodeHeic(
        source.stream,
        this.config.maxHeicBytes,
        MAX_INPUT_PIXELS,
      );
      this.logger.debug(
        `Decoded HEIC ${source.filename} (${decoded.raw.width}x${decoded.raw.height}) in ${Date.now() - startedAt}ms`,
      );
      return decoded;
    } catch (error) {
      if (error instanceof HttpError) {
        this.logger.warn(
          `Rejected HEIC upload ${source.filename}: ${error.message}`,
        );
        throw error;
      }
      this.logger.warn(
        `Rejected undecodable HEIC upload ${source.filename}: ${String(error)}`,
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
    return (await this.decodeUpload(source, transformer)).data;
  }

  // encodeUpload with the output's layout (raw pixels need it).
  private async decodeUpload(
    source: Readable,
    transformer: Sharp,
  ): Promise<{ data: Buffer; info: OutputInfo }> {
    // pipe() does not forward a source failure; toBuffer() must see it.
    source.on('error', (error) => transformer.destroy(error));
    try {
      return await source
        .pipe(transformer)
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      this.logger.warn(`Rejected unreadable upload: ${String(error)}`);
      throw exceedsPixelLimit(error)
        ? imageTooLarge()
        : new HttpError(400, 'Unreadable image');
    }
  }

  private async writeThumb(
    { fileName, variantKey }: StoredPhoto,
    thumbName: string,
  ): Promise<void> {
    const source =
      (await this.storage.get(variantFileName(fileName, 'nobg', variantKey))) ??
      (await this.getOrNotFound(fileName));
    const startedAt = Date.now();
    await this.transcode(source, thumbTransformer(), thumbName);
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

/** writeCutout's transaction: the row as it was locked, and what the machine answered. */
interface Swap {
  before: CutoutRow;
  outcome: Transition;
}

// The stored original's size and encoding (storeImage), and an edited
// cutout's (saveEditedCutout), over a decoder().
function originalTransformer(decoded: Sharp): Sharp {
  return decoded
    .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, {
      fit: sharp.fit.inside,
      withoutEnlargement: true,
    })
    .webp({ quality: IMAGE_QUALITY });
}

// Every thumb, from the cutout when there is one (writeThumb, writeCutout).
function thumbTransformer(): Sharp {
  return decoder()
    .resize(THUMB_MAX_PX, THUMB_MAX_PX, {
      fit: sharp.fit.inside,
      withoutEnlargement: true,
    })
    .webp({ quality: THUMB_QUALITY });
}

// Bytes Photos cannot read as any image: a 400.
function refuseNonImage(source: ImageSource): void {
  if (source.mimetype?.startsWith('image/')) return;
  // https://github.com/fastify/fastify-multipart/issues/497
  // An unconsumed multipart stream hangs the request: drain, then refuse.
  source.stream.resume();
  throw new HttpError(400, 'Wrong filetype');
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
 * reaches whoever awaits it (replacePhoto, from storeUploadParts). Node's default of crashing
 * on an unhandled rejection is kept on purpose: no process-level handler.
 */
function startPipeline<T>(pipeline: Promise<T>): Promise<T> {
  pipeline.catch(() => undefined);
  return pipeline;
}

/**
 * A cutout's pixels (RGBA) centred on a transparent square: the shape the
 * browser's model gave every older cutout, which the mask editor (it pads
 * the original the same way to paint it back) and the square tiles rely on.
 */
function squareCutout(
  rgba: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
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

function newPhotoRow(fileName: string, userId: number): NewPhotoRow {
  return {
    fileName,
    shareableId: randomUUID(),
    createdOn: new Date().toISOString(),
    createdById: userId,
  };
}
