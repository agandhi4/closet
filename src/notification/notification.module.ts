import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { User } from '../dal/entity/user.entity';
import { UserDevice } from '../dal/entity/userDevice.entity';

@Module({
  imports: [MikroOrmModule.forFeature([User, UserDevice])],
  providers: [NotificationService],
  controllers: [NotificationController],
})
export class NotificationModule {}
