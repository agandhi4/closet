import { MultipartFile } from '@fastify/multipart';
import { File } from '../dal/entity/file.entity';
import { Readable } from 'stream';
import { ImageVariant } from './image-variant';

export interface FileServiceInterface {
  /**
   * @param upload multipart stream plus mimetype; drained and rejected when not an image
   * @param userId user responsible for the file
   * @param fileName optional pre-chosen name so a cutout can be stored concurrently
   * @returns the persisted File row (version 1)
   */
  storeImageFromFileUpload(
    upload: MultipartFile | undefined,
    userId: any,
    fileName?: string,
  ): Promise<File>;
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
}
