import type { OutfitSlot } from '../../dal/entity/outfit.entity';

export interface UpdateOutfitDto {
  name?: string;
  notes?: string;
  slots?: OutfitSlot[];
}
