import { Module } from '@nestjs/common';
import { ViewContextService } from './view-context.service';

@Module({
  providers: [ViewContextService],
  exports: [ViewContextService],
})
export class ViewContextModule {}
