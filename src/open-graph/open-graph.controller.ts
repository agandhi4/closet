import { Controller, Get, Query, Render, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/public.decorator';
import { OpenGraphService } from './open-graph.service';

// The share link's landing page: opened by anyone the link was sent to, and
// fetched by link-preview crawlers for its Open Graph tags.
@Public()
@Controller('share')
export class OpenGraphController {
  constructor(private readonly openGraphService: OpenGraphService) {}

  @Get()
  @Render('share')
  share(
    @Query('shareableId') shareableId: string,
    @Query('type') type: string,
    @Req() req: FastifyRequest,
  ) {
    return this.openGraphService.getShareableTagValues(shareableId, type, req);
  }
}
