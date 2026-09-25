import { MultipartFile } from '@fastify/multipart';

export interface UpdateGarmentDto {
  name?: string;
  category?: string;
  brand?: string;
  /** Comma-joined GarmentColor values, see Garment.color. */
  color?: string;
  size?: string;
  notes?: string;
  washingDetails?: string;
  dateAquired?: string;
  files?: AsyncIterableIterator<MultipartFile>;
}
