import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { Garment } from '../dal/entity/garment.entity';
import { Outfit } from '../dal/entity/outfit.entity';
import { OutfitCalendar } from '../dal/entity/outfit-calendar.entity';
import { FileModule } from '../file/file.module';
import { WardrobeShareModule } from '../wardrobe-share/wardrobe-share.module';
import { GarmentService } from './garment.service';
import { OutfitService } from './outfit.service';
import { WardrobeController } from './wardrobe.controller';
import { OutfitController } from './outfit.controller';

@Module({
  imports: [
    FileModule,
    WardrobeShareModule,
    MikroOrmModule.forFeature([Garment, Outfit, OutfitCalendar]),
  ],
  // The calendar's routes live in src/web/calendar/ (plain Fastify).
  controllers: [WardrobeController, OutfitController],
  providers: [GarmentService, OutfitService],
  exports: [GarmentService, OutfitService],
})
export class WardrobeModule {}
