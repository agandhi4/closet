import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { File } from '../dal/entity/file.entity';
import { User } from '../dal/entity/user.entity';
import { FileController } from './controller/file.controller';
import { FileService } from './file-service.abstract';
import { FileUrlService } from './file-url/file-url.service';
import { LocalFileService } from './local-file/local-file.service';

// Nothing here needs a guard: FileController serves images without a
// session. createApp() hands FileService to the web layer for account
// deletion (src/web/auth/routes.tsx). Photos live on local disk under
// DATA_PATH, the only storage (the S3 backend was removed 2026-09-26).
@Module({
  imports: [MikroOrmModule.forFeature([File, User])],
  controllers: [FileController],
  providers: [
    { provide: FileService, useClass: LocalFileService },
    FileUrlService,
  ],
  exports: [FileService, FileUrlService],
})
export class FileModule {}
