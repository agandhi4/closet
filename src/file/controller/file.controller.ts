import { EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import {
  Controller,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  Post,
  Render,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../../auth/auth.guard';
import { Payload } from '../../auth/dto/payload.dto';
import { User } from '../../auth/user.decorator';
import { User as UserEntity } from '../../dal/entity/user.entity';
import { FileService } from '../file-service.abstract';
import { ConditionalAuthGuard } from '../../auth/conditional-auth.guard';
import { ImageVariant } from '../image-variant';

// Stored names are `<uuid>.webp`; anything else (path separators, dot
// segments, encoded slashes) is rejected before it reaches the backend.
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

@Controller('file')
export class FileController {
  private logger = new Logger(FileController.name);

  constructor(
    private readonly fileService: FileService,
    @InjectRepository(UserEntity)
    private readonly userRepository: EntityRepository<UserEntity>,
  ) {}

  @UseGuards(ConditionalAuthGuard)
  @Get('files')
  @Render('files')
  async getFiles(@User() payload: Payload) {
    const user = await this.userRepository.findOne(
      { id: payload.userId },
      { populate: ['fileUploads'] },
    );
    return {
      files: user?.fileUploads,
    };
  }

  @UseGuards(AuthGuard)
  @Post('upload')
  @Render('files')
  async uploadFile(@User() payload: Payload, @Req() req: FastifyRequest) {
    const data = await req.file();
    await this.fileService.storeImageFromFileUpload(data, payload.userId);
    const user = await this.userRepository.findOne(
      { id: payload.userId },
      { populate: ['fileUploads'] },
    );
    return {
      files: user?.fileUploads,
    };
  }

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
    if (!SAFE_FILE_NAME.test(fileName) || fileName.includes('..')) {
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
