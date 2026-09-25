import { MultipartFile } from '@fastify/multipart';
import { File } from '../dal/entity/file.entity';
import { Readable } from 'stream';
import { ImageVariant } from './image-variant';

/** One object as a backend reports it; `lastModified` is the backend's own timestamp. */
export interface StoredObject {
  name: string;
  lastModified?: Date;
}

export interface StoreImageOptions {
  /** Pre-chosen `<uuid>.webp`, so a cutout can be stored under it concurrently. */
  fileName?: string;
  /** The caller calls regenerateThumb after the cutout is stored too. */
  deferThumb?: boolean;
}

export interface FileServiceInterface {
  /**
   * @param upload multipart stream plus mimetype; drained and rejected when not an image
   * @param userId user responsible for the file
   * @param options pre-chosen name and deferred thumb for a photo+cutout pair
   * @returns the File row (version 1), not yet persisted: the caller commits
   *   it with the entity that references it and calls deleteVariants if that
   *   commit fails
   */
  storeImageFromFileUpload(
    upload: MultipartFile | undefined,
    userId?: number,
    options?: StoreImageOptions,
  ): Promise<File>;
  /** Same persistence contract as storeImageFromFileUpload. */
  copyImage(sourceFileName: string, userId?: number): Promise<File | undefined>;
  storeNobgVariantFromStream(
    stream: Readable,
    originalFileName: string,
    options: { newUpload: boolean },
  ): Promise<void>;
  getVariant(fileName: string, variant: ImageVariant): Promise<Readable>;
  regenerateThumb(fileName: string): Promise<void>;
  bumpVersion(fileName: string): Promise<number | undefined>;
  deleteVariants(fileName: string): Promise<void>;
  deleteById(fileId: any, userId: any): Promise<void>;
  get(fileName: string): Promise<Readable>;
  getByShareableId(shareableId: string): Promise<Readable>;
  delete(fileName: string): Promise<void>;
  /** Every object in the store, variants included; the caller filters. */
  list(): AsyncIterable<StoredObject>;
}
