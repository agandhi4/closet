import { IsEnum, IsOptional, IsString } from 'class-validator';
import { GarmentColor } from '../garment-color.enum';

/** Query string of GET /wardrobe; validated by the ValidationPipe on @Query(). */
export class SearchGarmentDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  category?: string;

  // Only enum names reach GarmentService.findAll, which is what makes its
  // `$like '%<color>%'` membership match safe without escaping wildcards.
  @IsOptional()
  @IsEnum(GarmentColor)
  color?: GarmentColor;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsString()
  archived?: string;
}
