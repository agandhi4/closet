import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { PROJECT_ROOT } from '../project-root';
import { createPhotos, Photos } from '../web/files/photos';
import { FileUrlService } from './file-url/file-url.service';

/**
 * Nest's handle on src/web/files: the process's one Photos instance, built
 * from config, for the garment code still in Nest (GarmentService) and for
 * createApp(), which hands the same instance to the web layer (the /file
 * routes, account deletion). One instance, because the thumb single-flight
 * lives in it. Goes when garments are ported and createApp() calls
 * createPhotos() itself.
 */
@Module({
  providers: [
    {
      provide: Photos,
      inject: [ConfigService, DB],
      useFactory: (config: ConfigService, db: Db): Photos =>
        createPhotos(
          {
            dataPath: config.getOrThrow<string>('DATA_PATH'),
            maxHeicBytes: config.getOrThrow<number>('MAX_HEIC_BYTES'),
            watermarkIconPath: join(
              PROJECT_ROOT,
              'public',
              'assets',
              config.getOrThrow<string>('ICON_NAME'),
            ),
            watermarkEnabled: config.getOrThrow<boolean>('WATERMARK_ENABLED'),
          },
          db,
          new Logger('Photos'),
        ),
    },
    FileUrlService,
  ],
  exports: [Photos, FileUrlService],
})
export class FileModule {}
