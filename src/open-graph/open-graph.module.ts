import { Module } from '@nestjs/common';
import { FileModule } from '../file/file.module';
import { OpenGraphController } from './open-graph.controller';
import { OpenGraphService } from './open-graph.service';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { File } from '../dal/entity/file.entity';
import { Garment } from '../dal/entity/garment.entity';

@Module({
  imports: [FileModule, MikroOrmModule.forFeature([File, Garment])],
  controllers: [OpenGraphController],
  providers: [OpenGraphService],
})
export class OpenGraphModule {}
