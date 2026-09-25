import { Injectable } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

// Only Open Graph previews need an absolute URL; templates use imageUrl().
@Injectable()
export class FileUrlService {
  getWatermarkedFileUrl(shareableId: string, req: FastifyRequest): string {
    return `${req.protocol}://${req.host}/file/watermark/${shareableId}`;
  }
}
