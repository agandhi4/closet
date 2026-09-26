import type { OutfitSlot } from '../../dal/entity/outfit.entity';

export interface CreateOutfitDto {
  name?: string;
  notes?: string;
  slots?: OutfitSlot[];
}
