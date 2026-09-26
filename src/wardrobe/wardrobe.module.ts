import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { Garment } from '../dal/entity/garment.entity';
import { FileModule } from '../file/file.module';
import { WardrobeShareModule } from '../wardrobe-share/wardrobe-share.module';
import { GarmentService } from './garment.service';
import { WardrobeController } from './wardrobe.controller';

@Module({
  imports: [
    FileModule,
    WardrobeShareModule,
    MikroOrmModule.forFeature([Garment]),
  ],
  // Outfits and the calendar live in src/web/ (plain Fastify, Drizzle).
  controllers: [WardrobeController],
  providers: [GarmentService],
  exports: [GarmentService],
})
export class WardrobeModule {}
