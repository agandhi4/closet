import { Module } from '@nestjs/common';
import { WardrobeShareService } from './wardrobe-share.service';

// Routes and views live in src/web/sharing; this module only provides the
// access resolver to the garment routes still in Nest.
@Module({
  providers: [WardrobeShareService],
  exports: [WardrobeShareService],
})
export class WardrobeShareModule {}
