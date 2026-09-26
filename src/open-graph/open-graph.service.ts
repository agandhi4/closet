import { Inject, Injectable } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { FileUrlService } from '../file/file-url/file-url.service';
import { InjectRepository } from '@mikro-orm/nestjs';
import { File } from '../dal/entity/file.entity';
import { Garment } from '../dal/entity/garment.entity';
import { EntityRepository } from '@mikro-orm/core';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { findSharedOutfit } from '../web/outfits/queries';

export interface OpenGraphTagValues {
  ogUrl: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
}

@Injectable()
export class OpenGraphService {
  constructor(
    private readonly fileUrlService: FileUrlService,
    @InjectRepository(File)
    private readonly fileRepository: EntityRepository<File>,
    @InjectRepository(Garment)
    private readonly garmentRepository: EntityRepository<Garment>,
    // Outfits are ported (src/web/outfits); their share page reads through
    // the feature's query until this module is ported too.
    @Inject(DB) private readonly db: Db,
  ) {}

  public async getShareableTagValues(
    shareableId: string,
    type: string,
    req: FastifyRequest,
  ) {
    if (type == 'file') {
      const file = await this.fileRepository.findOne(
        { shareableId },
        {
          populate: ['createdBy'],
        },
      );
      const createdBy = await file?.createdBy.load();
      return {
        ogUrl: `${req.protocol}://${req.host}/file/${shareableId}`,
        ogTitle: file?.fileName,
        ogDescription: `From ${createdBy?.email}`,
        ogImage: this.fileUrlService.getWatermarkedFileUrl(shareableId, req),
        file,
        createdBy,
      };
    }

    if (type == 'garment') {
      const garment = await this.garmentRepository.findOne(
        { shareableId },
        { populate: ['owner', 'photo'] },
      );
      const createdBy = await garment?.owner.load();
      const ogImage = garment?.photo
        ? this.fileUrlService.getWatermarkedFileUrl(
            garment.photo.shareableId,
            req,
          )
        : undefined;
      return {
        ogUrl: `${req.protocol}://${req.host}/share?shareableId=${shareableId}&type=garment`,
        ogTitle: garment?.name,
        ogDescription: `From ${createdBy?.email}`,
        ogImage,
        garment,
        createdBy,
      };
    }

    if (type == 'outfit') {
      const outfit = await findSharedOutfit(this.db, shareableId);
      const createdBy = outfit?.owner;
      // The first garment, in the outfit's order, that has a photo.
      const firstPhoto = outfit?.garments.find((g) => g.photo)?.photo;
      const ogImage = firstPhoto
        ? this.fileUrlService.getWatermarkedFileUrl(firstPhoto.shareableId, req)
        : undefined;
      return {
        ogUrl: `${req.protocol}://${req.host}/share?shareableId=${shareableId}&type=outfit`,
        ogTitle: outfit?.name,
        ogDescription: `From ${createdBy?.email}`,
        ogImage,
        outfit,
        garments: outfit?.garments ?? [],
        createdBy,
      };
    }
  }
}
