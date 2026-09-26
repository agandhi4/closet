import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type PushSubscription } from 'web-push';
import { UserId } from '../auth/user.decorator';
import { NotificationService } from './notification.service';
import { PushNotificationDto } from './dto/pushNotification.dto';

@Controller('notification')
export class NotificationController {
  constructor(
    private notificationService: NotificationService,
    private configService: ConfigService,
  ) {}

  @Get('vapid-public-key')
  getVapidPublicKey() {
    return this.configService.getOrThrow<string>('PUBLIC_VAPID_KEY');
  }

  // public/js/webPush.js fetches this and the key above; without a session
  // SessionGuard answers the fetch with a 401.
  @Post('subscribe')
  async postSubscribe(
    @Headers('user-agent') userAgent: string,
    @UserId() userId: number,
    @Body() body: PushSubscription,
  ) {
    await this.notificationService.addUserWebPushNotificationSubscription(
      userId,
      body,
      userAgent,
    );
  }

  @Post('test')
  async postTest(@UserId() userId: number) {
    await this.notificationService.sendWebPushNotification(
      {
        title: 'Test Web Push',
        body: 'body',
      } as PushNotificationDto,
      userId,
    );
  }
}
