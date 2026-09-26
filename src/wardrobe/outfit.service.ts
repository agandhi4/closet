import { EntityRepository, wrap } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { Garment } from '../dal/entity/garment.entity';
import { Outfit, OutfitSlot } from '../dal/entity/outfit.entity';
import { GarmentCategory } from './garment-category.enum';
import { GarmentService } from './garment.service';
import { CreateOutfitDto } from './dto/create-outfit.dto';
import { UpdateOutfitDto } from './dto/update-outfit.dto';
import { imageUrl } from '../file/file-url/image-url';
@Injectable()
export class OutfitService {
  private readonly logger = new Logger(OutfitService.name);

  constructor(
    @InjectRepository(Outfit)
    private readonly outfitRepository: EntityRepository<Outfit>,
    @InjectRepository(Garment)
    private readonly garmentRepository: EntityRepository<Garment>,
    private readonly garmentService: GarmentService,
  ) {}

  async findAll(userId: number): Promise<Outfit[]> {
    return this.outfitRepository.find(
      { owner: { id: userId } },
      { populate: ['garments', 'garments.photo'] },
    );
  }

  // Outfits are private to their owner whatever wardrobe shares exist.
  async findOne(id: number, userId: number): Promise<Outfit> {
    const outfit = await this.outfitRepository.findOne(id, {
      populate: ['garments', 'garments.photo'],
    });
    if (!outfit) throw new NotFoundException('Outfit not found');
    if (outfit.owner.id !== userId) throw new ForbiddenException();
    return outfit;
  }

  async findOneByShareableId(shareableId: string): Promise<Outfit> {
    const outfit = await this.outfitRepository.findOne(
      { shareableId },
      { populate: ['garments', 'garments.photo'] },
    );
    if (!outfit) throw new NotFoundException('Outfit not found');
    return outfit;
  }

  async create(dto: CreateOutfitDto, userId: number): Promise<Outfit> {
    const outfit = this.outfitRepository.create({
      name: dto.name,
      notes: dto.notes,
      slots: dto.slots,
      owner: userId,
    });

    const garmentIds =
      dto.slots
        ?.map((s) => s.garmentId)
        .filter((id): id is number => id !== null) ?? [];

    if (garmentIds.length) {
      outfit.garments.set(await this.findOwnedGarments(garmentIds, userId));
    }

    // One flush: the outfit row and its pivot rows commit together.
    await this.outfitRepository.getEntityManager().persistAndFlush(outfit);
    this.logger.log(
      `Outfit ${outfit.id} created for user ${userId} with ${garmentIds.length} garments`,
    );
    return outfit;
  }

  // The form only offers the user's own garments; ids outside that set
  // (hand-edited requests) are dropped rather than attached.
  private findOwnedGarments(
    garmentIds: number[],
    userId: number,
  ): Promise<Garment[]> {
    return this.garmentRepository.find({
      id: { $in: garmentIds },
      owner: { id: userId },
    });
  }

  async update(
    id: number,
    dto: UpdateOutfitDto,
    userId: number,
  ): Promise<Outfit> {
    const outfit = await this.findOne(id, userId);

    wrap(outfit).assign({
      name: dto.name ?? outfit.name,
      notes: dto.notes ?? outfit.notes,
      slots: dto.slots ?? outfit.slots,
    });

    if (dto.slots !== undefined) {
      const garmentIds = dto.slots
        .map((s) => s.garmentId)
        .filter((id): id is number => id !== null);
      outfit.garments.set(await this.findOwnedGarments(garmentIds, userId));
    }

    await this.outfitRepository.getEntityManager().flush();
    this.logger.log(`Outfit ${id} updated by user ${userId}`);
    return outfit;
  }

  async remove(id: number, userId: number): Promise<void> {
    const outfit = await this.findOne(id, userId);
    await this.outfitRepository.getEntityManager().removeAndFlush(outfit);
    this.logger.log(`Outfit ${id} removed by user ${userId}`);
  }

  parseSlotsFromBody(
    category: string | string[] | undefined,
    garmentId: string | string[] | undefined,
  ): OutfitSlot[] {
    const cats = Array.isArray(category)
      ? category
      : category
        ? [category]
        : [];
    const ids = Array.isArray(garmentId)
      ? garmentId
      : garmentId
        ? [garmentId]
        : [];
    return cats.map((cat, i) => ({
      category: cat,
      garmentId: ids[i] ? Number(ids[i]) : null,
    }));
  }

  buildCategoryRows(
    garments: Garment[],
    selectedIds: number[],
    i18n: I18nContext,
    slots?: OutfitSlot[],
  ) {
    const grouped: Partial<Record<string, Garment[]>> = {};
    for (const g of garments) {
      (grouped[g.category] ??= []).push(g);
    }

    const toRow = (
      category: string,
      items: Garment[],
      selectedId: number | null,
      defaultFirst = false,
    ) => {
      const selectedIdx =
        selectedId != null ? items.findIndex((g) => g.id === selectedId) : -1;
      let idx = 0;
      if (selectedIdx >= 0) {
        idx = selectedIdx + 1;
      } else if (defaultFirst && items.length > 0) {
        idx = 1;
      }
      return this.buildRow(category, items, idx, i18n);
    };

    // Slot-based path: preserves saved order and duplicate categories
    if (slots?.length) {
      return slots
        .filter((slot) => grouped[slot.category]?.length)
        .map((slot) => {
          const items = grouped[slot.category]!;
          const selected =
            slot.garmentId != null
              ? (items.find((g) => g.id === slot.garmentId) ?? null)
              : null;
          return toRow(slot.category, items, selected?.id ?? null, false);
        });
    }

    // Fallback: enum order, one row per category with garments
    const enumOrder = Object.values(GarmentCategory);
    const orderedKeys = [
      ...enumOrder.filter((c) => grouped[c]?.length),
      ...Object.keys(grouped)
        .filter(
          (c) => !(enumOrder as string[]).includes(c) && grouped[c]?.length,
        )
        .sort(),
    ];
    return orderedKeys.map((cat) => {
      const items = grouped[cat]!;
      const selected = items.find((g) => selectedIds.includes(g.id)) ?? null;
      return toRow(cat, items, selected?.id ?? null, true);
    });
  }

  buildRow(category: string, items: Garment[], idx: number, i18n: I18nContext) {
    const count = items.length;
    const sel = idx > 0 ? (items[idx - 1] ?? null) : null;
    return {
      value: category,
      label: this.garmentService.resolveCategoryLabel(category, i18n),
      garmentCount: count,
      currentIndex: idx,
      prevIndex: idx === 0 ? count : idx - 1,
      nextIndex: idx === count ? 0 : idx + 1,
      currentGarment: sel
        ? {
            id: sel.id,
            name: sel.name,
            photo: sel.photo ? imageUrl(sel.photo, 'nobg') : null,
            brand: sel.brand ?? null,
            color: sel.color ?? null,
            size: sel.size ?? null,
            notes: sel.notes ?? null,
          }
        : null,
      garmentId: sel?.id ?? null,
    };
  }
}
