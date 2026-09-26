import { EntityRepository, FilterQuery } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/knex';
import { InjectRepository } from '@mikro-orm/nestjs';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { Garment } from '../dal/entity/garment.entity';
import { File } from '../dal/entity/file.entity';
import { FileService } from '../file/file-service.abstract';
import { MultipartFile } from '@fastify/multipart';
import { CreateGarmentDto } from './dto/create-garment.dto';
import { UpdateGarmentDto } from './dto/update-garment.dto';
import { SearchGarmentDto } from './dto/search-garment.dto';
import { GarmentCategory } from './garment-category.enum';
import { WardrobeShareService } from '../wardrobe-share/wardrobe-share.service';

const CANONICAL_SIZES = [
  'XX-Small',
  'X-Small',
  'Small',
  'Medium',
  'Large',
  'X-Large',
  'XX-Large',
  '3X-Large',
  '4X-Large',
  '5X-Large',
];

export interface AvailableFilters {
  brands: string[];
  sizes: string[];
  categories: string[];
}

@Injectable()
export class GarmentService {
  private readonly logger = new Logger(GarmentService.name);

  constructor(
    @InjectRepository(Garment)
    private readonly garmentRepository: EntityRepository<Garment>,
    private readonly em: EntityManager,
    private readonly fileService: FileService,
    private readonly shareService: WardrobeShareService,
  ) {}

  resolveCategoryLabel(value: string, i18n: I18nContext): string {
    const normalized = value.toLowerCase();
    if ((Object.values(GarmentCategory) as string[]).includes(normalized)) {
      return i18n.t(`lang.CATEGORY_${normalized.toUpperCase()}`);
    }
    return value;
  }

  /**
   * One wardrobe's garments: `viewOwner`'s when given (the caller has already
   * checked the requester may view it), otherwise the requester's own.
   */
  async findAll(
    userId: number,
    dto: SearchGarmentDto = {},
    viewOwner?: number,
  ): Promise<Garment[]> {
    const normalizedSize = this.normalizeSize(dto.size);
    const searchConditions: FilterQuery<Garment> = {
      ...(dto.category ? { category: dto.category } : {}),
      // color holds a comma-joined list; enum names never contain each other,
      // so a substring match is an exact membership test.
      ...(dto.color ? { color: { $like: `%${dto.color}%` } } : {}),
      ...(normalizedSize ? { size: normalizedSize } : {}),
      ...(dto.archived !== 'true' ? { archived: false } : {}),
      ...(dto.keyword
        ? {
            $or: [
              { name: { $like: `%${dto.keyword}%` } },
              { notes: { $like: `%${dto.keyword}%` } },
              { brand: { $like: `%${dto.keyword}%` } },
            ],
          }
        : {}),
    };

    return this.garmentRepository.find(
      { owner: { id: viewOwner ?? userId }, ...searchConditions },
      { populate: ['photo'], orderBy: { id: 'DESC' } },
    );
  }

  async findOne(
    id: number,
    userId: number,
    viewOwner?: number,
  ): Promise<Garment> {
    const garment = await this.garmentRepository.findOne(id, {
      populate: ['photo'],
    });
    // One answer for "no such garment", "in a wardrobe you cannot see" and
    // "not in the wardrobe this request addresses": ids reveal nothing (see
    // WardrobeAccess). The garment must belong to the addressed wardrobe,
    // not merely to some wardrobe the user can see.
    if (!garment) throw new NotFoundException('Garment not found');
    const access = await this.shareService.resolveAccess(userId, viewOwner);
    if (!access.canView || garment.owner.id !== access.ownerId) {
      throw new NotFoundException('Garment not found');
    }
    return garment;
  }

  async findOneByShareableId(shareableId: string): Promise<Garment> {
    const garment = await this.garmentRepository.findOne(
      { shareableId },
      { populate: ['photo'] },
    );
    if (!garment) throw new NotFoundException('Garment not found');
    return garment;
  }

  /** `ownerId`: the wardrobe the garment lands in (a MANAGE grantee may add to another's). */
  async create(dto: CreateGarmentDto, ownerId: number): Promise<Garment> {
    const photo = await this.storeUploadedPhoto(dto.files, ownerId);
    const garment = await this.commitWithPhoto(photo, (em) =>
      em.create(Garment, {
        name: dto.name,
        category: dto.category,
        brand: dto.brand,
        color: dto.color,
        size: this.normalizeSize(dto.size),
        notes: dto.notes,
        washingDetails: dto.washingDetails,
        dateAquired: dto.dateAquired ? new Date(dto.dateAquired) : undefined,
        photo,
        owner: ownerId,
      }),
    );
    this.logger.log(
      `Garment ${garment.id} created for user ${ownerId}${photo ? ` with photo ${photo.fileName}` : ''}`,
    );
    return garment;
  }

  async clone(
    sourceId: number,
    dto: {
      name?: string;
      category: string;
      brand?: string;
      color?: string;
      size?: string;
      notes?: string;
    },
    userId: number,
  ): Promise<Garment> {
    const source = await this.garmentRepository.findOne(sourceId, {
      populate: ['photo'],
    });
    if (!source) throw new NotFoundException('Garment not found');

    const photo = source.photo?.fileName
      ? await this.fileService.copyImage(source.photo.fileName, userId)
      : undefined;

    const garment = await this.commitWithPhoto(photo, (em) =>
      em.create(Garment, {
        name: dto.name,
        category: dto.category,
        brand: dto.brand,
        color: dto.color,
        size: this.normalizeSize(dto.size),
        notes: dto.notes,
        photo,
        owner: userId,
      }),
    );
    this.logger.log(
      `Garment ${garment.id} cloned from ${sourceId} for user ${userId}`,
    );
    return garment;
  }

  /**
   * Distinct brand, size and category values of one wardrobe, straight from
   * the database: the list pages call this next to the filtered list query
   * and must not rescan every row.
   */
  async findAvailableFilters(ownerId: number): Promise<AvailableFilters> {
    const [brands, sizes, categories] = await Promise.all([
      this.distinctValues('brand', ownerId),
      this.distinctValues('size', ownerId),
      this.distinctValues('category', ownerId),
    ]);
    return {
      brands: brands.sort(),
      sizes: sizes.sort(compareSizes),
      categories: categories.sort(),
    };
  }

  private async distinctValues(
    column: 'brand' | 'size' | 'category',
    ownerId: number,
  ): Promise<string[]> {
    const rows: Record<typeof column, string | null>[] = await this.em
      .createQueryBuilder(Garment)
      .select(column, true)
      .where({ owner: { id: ownerId }, [column]: { $ne: null } })
      .execute();
    // Empty strings are stored for cleared form fields; they are not values.
    return rows
      .map((row) => row[column])
      .filter((value): value is string => !!value);
  }

  /**
   * `ownerId` is the wardrobe the garment belongs to, `requestingUserId` who
   * asks (the owner or a MANAGE grantee); findOne re-checks both.
   */
  async update(
    id: number,
    dto: UpdateGarmentDto,
    ownerId: number,
    requestingUserId: number,
  ): Promise<Garment> {
    const photo = dto.files
      ? await this.storeUploadedPhotoWithCutout(id, dto.files, ownerId)
      : undefined;

    const { garment, replacedPhoto } = await this.commitWithPhoto(
      photo,
      async (em) => {
        const garment = await this.findOne(id, requestingUserId, ownerId);
        const replacedPhoto = photo ? garment.photo : undefined;
        if (photo) {
          garment.photo = photo;
          // The old row goes with the old bytes; the FK is set null on delete
          // but the garment already points at the new photo in this flush.
          if (replacedPhoto) em.remove(replacedPhoto);
        }
        this.applyFields(garment, dto);
        return { garment, replacedPhoto };
      },
    );

    // Only after commit: an unlink cannot be rolled back.
    if (photo && replacedPhoto) {
      await this.fileService.deleteVariants(replacedPhoto.fileName);
      this.logger.log(
        `Garment ${id} photo replaced: ${replacedPhoto.fileName} -> ${photo.fileName}`,
      );
    }
    return garment;
  }

  // A key present in the DTO is an edit, even to empty; an absent key keeps
  // the stored value (the photo-only form posts no fields at all).
  private applyFields(garment: Garment, dto: UpdateGarmentDto): void {
    garment.name = dto.name ?? garment.name;
    garment.category = dto.category ?? garment.category;
    if ('brand' in dto) garment.brand = dto.brand;
    if ('color' in dto) garment.color = dto.color;
    if ('size' in dto) garment.size = this.normalizeSize(dto.size);
    if ('notes' in dto) garment.notes = dto.notes;
    if ('washingDetails' in dto) garment.washingDetails = dto.washingDetails;
    if ('dateAquired' in dto)
      garment.dateAquired = dto.dateAquired
        ? new Date(dto.dateAquired)
        : undefined;
  }

  /**
   * Replaces the cutout after a mask edit. Returns the photo's version after
   * the write so the client can point at the new immutable URL; undefined
   * when the garment has no photo or no cutout was sent.
   */
  async updateNobg(
    id: number,
    nobgPhoto: MultipartFile | undefined,
    ownerId: number,
    requestingUserId: number,
  ): Promise<number | undefined> {
    const garment = await this.findOne(id, requestingUserId, ownerId);
    if (!garment.photo?.fileName || !nobgPhoto) return undefined;
    await this.fileService.storeNobgVariantFromStream(
      nobgPhoto.file,
      garment.photo.fileName,
      { newUpload: false },
    );
    // storeNobgVariantFromStream bumped the same managed File instance
    // (identity map), so the populated photo already carries the new version.
    this.logger.log(
      `Garment ${id} cutout replaced, photo version ${garment.photo.version}`,
    );
    return garment.photo.version;
  }

  /** Garment and its File row go in one transaction; the bytes after commit. */
  async remove(id: number, userId: number): Promise<void> {
    const photo = await this.em.transactional(async (em) => {
      const garment = await this.findOne(id, userId);
      em.remove(garment);
      if (garment.photo) em.remove(garment.photo);
      return garment.photo;
    });
    if (photo) await this.fileService.deleteVariants(photo.fileName);
    this.logger.log(`Garment ${id} removed by user ${userId}`);
  }

  async archive(id: number, userId: number): Promise<Garment> {
    const garment = await this.findOne(id, userId);
    garment.archived = !garment.archived;
    await this.em.flush();
    return garment;
  }

  /**
   * Commits `write` in one transaction. The photo's bytes were written before
   * this point; if the rows do not land, the bytes are removed again so
   * storage never holds a file no row points at.
   */
  private async commitWithPhoto<T>(
    photo: File | undefined,
    write: (em: EntityManager) => T | Promise<T>,
  ): Promise<T> {
    try {
      return await this.em.transactional((em) => Promise.resolve(write(em)));
    } catch (error) {
      if (photo) {
        this.logger.warn(
          `Rolled back; removing orphaned upload ${photo.fileName}`,
        );
        await this.fileService.deleteVariants(photo.fileName);
      }
      throw error;
    }
  }

  private async storeUploadedPhoto(
    files: AsyncIterableIterator<MultipartFile> | undefined,
    ownerId: number,
  ): Promise<File | undefined> {
    if (!files) return undefined;
    let photo: File | undefined;
    for await (const file of files) {
      if (file.fieldname === 'photo') {
        photo = await this.fileService.storeImageFromFileUpload(file, ownerId);
      } else {
        file.file.resume();
      }
    }
    return photo;
  }

  // @fastify/multipart yields live streams; if a stream isn't consumed, the
  // parser backpressures and the async iterator hangs. Each file's pipeline
  // must be started (not awaited) inside the loop so busboy can advance to
  // the next part.
  //
  // IMPORTANT: photo and nobgPhoto pipelines must be started concurrently,
  // not sequentially. Both come from the same multipart request body:
  // awaiting one before starting the other would hang the iterator.
  private async storeUploadedPhotoWithCutout(
    garmentId: number,
    files: AsyncIterableIterator<MultipartFile>,
    ownerId: number,
  ): Promise<File | undefined> {
    let photoPromise: Promise<File> | undefined;
    let nobgPromise: Promise<void> | undefined;
    const photoFileName = `${randomUUID()}.webp`;

    for await (const file of files) {
      if (file.fieldname === 'photo') {
        photoPromise = startPipeline(
          this.fileService.storeImageFromFileUpload(file, ownerId, {
            fileName: photoFileName,
            deferThumb: true,
          }),
        );
      } else if (file.fieldname === 'nobgPhoto') {
        nobgPromise = startPipeline(
          this.fileService.storeNobgVariantFromStream(
            file.file,
            photoFileName,
            { newUpload: true },
          ),
        );
      } else {
        file.file.resume();
      }
    }

    if (!photoPromise) {
      if (nobgPromise) {
        // Invariant: a cutout only ever accompanies a photo in the same
        // request. The nobg pipeline had to be started above (multipart parts
        // arrive in client order, and an unconsumed part hangs the parser),
        // so drain it, remove whatever it wrote under the never-persisted
        // name, and reject.
        await nobgPromise.catch((err) => this.logger.warn(err));
        await this.fileService.deleteVariants(photoFileName);
        this.logger.warn(
          `Garment ${garmentId} update carried nobgPhoto without photo; discarded`,
        );
        throw new BadRequestException('nobgPhoto requires photo');
      }
      return undefined;
    }

    // Both pipelines must settle before anything is cleaned up: one may still
    // be writing under photoFileName while the other has already failed.
    const [photoResult, nobgResult] = await Promise.allSettled([
      photoPromise,
      nobgPromise ?? Promise.resolve(),
    ]);
    const failure = [photoResult, nobgResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      await this.fileService.deleteVariants(photoFileName);
      throw failure.reason;
    }
    const photo = (photoResult as PromiseFulfilledResult<File>).value;

    // The one thumb, built after both halves are stored so it reads the
    // cutout when there is one (neither pipeline builds its own).
    try {
      await this.fileService.regenerateThumb(photoFileName);
    } catch (error) {
      await this.fileService.deleteVariants(photoFileName);
      throw error;
    }
    return photo;
  }

  private normalizeSize(input?: string): string | undefined {
    if (!input) return undefined;
    const s = input
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '');
    if (['xxxxxl', '5xl', '5xlarge', 'xxxxxlarge'].includes(s))
      return '5X-Large';
    if (['xxxxl', '4xl', '4xlarge', 'xxxxlarge'].includes(s)) return '4X-Large';
    if (['xxxl', '3xl', '3xlarge', 'xxxlarge'].includes(s)) return '3X-Large';
    if (['xxl', '2xl', '2xlarge', 'xxlarge'].includes(s)) return 'XX-Large';
    if (['xl', 'xlarge'].includes(s)) return 'X-Large';
    if (['l', 'large'].includes(s)) return 'Large';
    if (['m', 'medium'].includes(s)) return 'Medium';
    if (['s', 'small'].includes(s)) return 'Small';
    if (['xs', 'xsmall'].includes(s)) return 'X-Small';
    if (['xxs', '2xs', '2xsmall', 'xxsmall'].includes(s)) return 'XX-Small';
    return input.trim();
  }
}

/**
 * Arms a pipeline started inside a multipart `for await` loop so that a
 * rejection while the loop is still consuming later parts is never an
 * unhandled rejection (which kills the process). The original promise is
 * returned untouched: the real error still surfaces from the later
 * Promise.allSettled.
 */
function startPipeline<T>(pipeline: Promise<T>): Promise<T> {
  pipeline.catch(() => undefined);
  return pipeline;
}

/** Canonical sizes in wearing order first, anything custom alphabetically after. */
function compareSizes(a: string, b: string): number {
  const ai = CANONICAL_SIZES.indexOf(a);
  const bi = CANONICAL_SIZES.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}
