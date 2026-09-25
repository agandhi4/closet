import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '../dal/entity/user.entity';
import webpush from 'web-push';
import _ from 'lodash';
import { UserDevice } from '../dal/entity/userDevice.entity';
import { PushNotificationDto } from './dto/pushNotification.dto';

@Injectable()
export class NotificationService {
  private logger = new Logger(NotificationService.name);

  // Web Push is a PWA feature: VAPID keys are only required (and only
  // validated by web-push, which rejects empty keys and non-https subjects)
  // when PWA_ENABLED is true. See the Joi schema in app.module.ts.
  private readonly pushConfigured: boolean;

  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepository: EntityRepository<User>,
    @InjectRepository(UserDevice)
    private userDeviceRepository: EntityRepository<UserDevice>,
    private readonly em: EntityManager,
  ) {
    this.pushConfigured =
      this.configService.get<boolean>('PWA_ENABLED') === true;
    if (!this.pushConfigured) {
      this.logger.log(
        'PWA disabled; web push notifications are not configured',
      );
      return;
    }
    webpush.setVapidDetails(
      this.configService.getOrThrow<string>('SITE_URL'),
      this.configService.getOrThrow<string>('PUBLIC_VAPID_KEY'),
      this.configService.getOrThrow<string>('PRIVATE_VAPID_KEY'),
    );
    this.logger.log('Web push notifications configured');
  }

  public async addUserWebPushNotificationSubscription(
    userId: any,
    subscription: webpush.PushSubscription,
    userAgent: string,
  ): Promise<void> {
    const user = await this.userRepository.findOneOrFail(
      { id: userId },
      {
        populate: ['userDevices'],
      },
    );
    const userDevices = await user?.userDevices?.loadItems();
    if (
      user &&
      !userDevices?.find((x) => _.isEqual(x.webPushSubscription, subscription))
    ) {
      const userDevice = this.userDeviceRepository.create({
        user: user.id,
        pushEndpoint: subscription.endpoint,
        webPushSubscription: subscription,
        userAgent,
      });
      await this.em.persistAndFlush(userDevice);
    } else {
      this.logger.warn(
        'User device web push notification subscription already stored.',
      );
    }
  }

  async sendWebPushNotification(
    notification: PushNotificationDto,
    userId: any,
  ) {
    if (!this.pushConfigured) {
      this.logger.warn(
        `Dropping web push notification for user ${userId}: PWA disabled`,
      );
      return;
    }
    const user = await this.userRepository.findOneOrFail(
      { id: userId },
      {
        populate: ['userDevices'],
      },
    );
    const webPushSubscriptions = (await user.userDevices.loadItems())
      .map((x) => x.webPushSubscription)
      .filter((val) => val);
    for (const subscription of webPushSubscriptions) {
      if (subscription) {
        webpush
          .sendNotification(
            subscription,
            JSON.stringify({
              ...notification,
              icon: `${this.configService.get('SITE_URL')}/assets/${this.configService.getOrThrow('ICON_NAME')}`,
            }),
          )
          .then((log) => {
            this.logger.debug('Push notification sent.');
            this.logger.debug(log);
          })
          .catch((error) => {
            this.logger.warn(error);
          });
      }
    }
  }
}
