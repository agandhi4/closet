import {
  Controller,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../auth/public.decorator';
import { FileService } from '../file-service.abstract';
import { ImageVariant, parseStoredName } from '../image-variant';

// The route segment must be a photo's base name, `<uuid>.webp`, as defined
// once by parseStoredName (reconciliation uses the same rule). DATA_PATH also
// holds app.log: a looser "safe characters" check here served it, session
// cookies included, to anyone. Variant names (`-thumb`, `-nobg`) are reached
// only through their own routes.
function isPhotoBaseName(fileName: string): boolean {
  return parseStoredName(fileName)?.variant === 'original';
}

// Images only, no pages: every route here is under the /file/ static prefix
// (static-prefixes.ts), so the session hook in app.ts skips it. A page added
// here would render without reply.locals.
//
// @Public(): there is never a session to check here (the hook is skipped),
// and the photos are addressed by unguessable UUID names with immutable
// caching; share previews and Open Graph images must load for anyone.
@Public()
@Controller('file')
export class FileController {
  private logger = new Logger(FileController.name);

  constructor(private readonly fileService: FileService) {}

  // Image variants. URLs carry `?v=<File.version>` (see imageUrl()), which is
  // what makes the one-year immutable cache safe: a rewritten image is only
  // ever reached through a new version.
  @Get(':fileName')
  async getFile(
    @Param('fileName') fileName: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendVariant(fileName, 'original', reply);
  }

  @Get('nobg/:fileName')
  async nobg(@Param('fileName') fileName: string, @Res() reply: FastifyReply) {
    return this.sendVariant(fileName, 'nobg', reply);
  }

  @Get('thumb/:fileName')
  async thumb(@Param('fileName') fileName: string, @Res() reply: FastifyReply) {
    return this.sendVariant(fileName, 'thumb', reply);
  }

  @Get('watermark/:shareableId')
  @Header('Cache-Control', 'public, max-age=86400') // public for CDN, max-age= 24hrs in seconds
  @Header('content-type', 'image/jpeg')
  async watermark(@Param('shareableId') shareableId: string) {
    const fileStream = await this.fileService.getByShareableId(shareableId);
    return this.fileService.watermarkImage(fileStream);
  }

  private async sendVariant(
    fileName: string,
    variant: ImageVariant,
    reply: FastifyReply,
  ) {
    if (!isPhotoBaseName(fileName)) {
      throw new NotFoundException();
    }
    const stream = await this.fileService.getVariant(fileName, variant);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Content-Type', 'image/webp');
    // Log stream errors, but don't try to re-send if headers are already in flight
    stream.on('error', (err) => {
      this.logger.error(err);
      if (!reply.sent) {
        reply.code(500).send({ message: 'Internal server error' });
      }
    });
    return reply.send(stream);
  }
}
