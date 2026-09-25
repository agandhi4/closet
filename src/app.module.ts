import { MikroORM } from '@mikro-orm/core';
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import Joi from 'joi';
import * as path from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DalModule } from './dal/dal.module';
import { NotificationModule } from './notification/notification.module';
import { FileModule } from './file/file.module';
import { EmailModule } from './email/email.module';
import { AcceptLanguageResolver, I18nModule } from 'nestjs-i18n';
import { OpenGraphModule } from './open-graph/open-graph.module';
import { WardrobeModule } from './wardrobe/wardrobe.module';
import { WardrobeShareModule } from './wardrobe-share/wardrobe-share.module';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { User } from './dal/entity/user.entity';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ErrorViewFilter } from './error-view.filter';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { ViewContextModule } from './view-context/view-context.module';

// Loopback only: right for `npm run start:prod` on a laptop, wrong behind a
// containerised reverse proxy (production sets the Docker bridge range).
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.1,::1';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const options = {
          singleLine: true,
          colorize: true,
          levelFirst: false,
          translateTime: 'yyyy-mm-dd HH:MM:ss',
          destination: 1,
        };
        return {
          pinoHttp: {
            level: configService.getOrThrow<string>('LOG_LEVEL'),
            transport: {
              targets: [
                {
                  target: 'pino-pretty',
                  level: 'info',
                  options,
                },
                {
                  target: 'pino-pretty',
                  level: 'info',
                  options: {
                    ...options,
                    // app.log file in data path
                    destination: path.join(
                      configService.getOrThrow('DATA_PATH'),
                      'app.log',
                    ),
                    mkdir: true,
                  },
                },
              ],
            },
          },
        };
      },
    }),
    ConfigModule.forRoot({
      envFilePath: ['.env.local', '.env'],
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('production'),
        PORT: Joi.number().default(3000),
        // pino level for both the console and app.log; `silent` is what the
        // integration harness uses so test output is only jest's.
        LOG_LEVEL: Joi.string()
          .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent')
          .default('info'),
        // Comma-separated IPs/CIDRs whose X-Forwarded-* headers are trusted
        // (Fastify trustProxy). Consumed in app.ts before the app exists.
        TRUSTED_PROXIES: Joi.string().default(DEFAULT_TRUSTED_PROXIES),
        APP_NAME: Joi.string().default('Closet'),
        AUTH_ENABLED: Joi.boolean().default(false),
        DISABLE_REGISTRATION: Joi.boolean().default(false),
        PWA_ENABLED: Joi.boolean().default(false),
        ACCESS_TOKEN_SECRET: Joi.string().default('ChangeMe!'),
        // No defaults on purpose: a PWA deploy that forgot its VAPID keys must
        // fail at boot rather than push with a keypair anyone can read from git.
        PUBLIC_VAPID_KEY: Joi.string().when('PWA_ENABLED', {
          is: true,
          then: Joi.required(),
          otherwise: Joi.optional(),
        }),
        PRIVATE_VAPID_KEY: Joi.string().when('PWA_ENABLED', {
          is: true,
          then: Joi.required(),
          otherwise: Joi.optional(),
        }),
        // Also the VAPID subject (see NotificationService) and the base of
        // absolute asset URLs in push payloads.
        SITE_URL: Joi.string().default('http://localhost:3000'),
        // File under public/assets/ used for apple-touch-icon, Open Graph
        // previews, push notification icons and the share-link watermark.
        ICON_NAME: Joi.string().default('icon.png'),
        // Composite the app icon onto share-link Open Graph images.
        WATERMARK_ENABLED: Joi.boolean().default(false),
        DATA_PATH: Joi.string().default(path.join(process.cwd(), 'data')),
        DATABASE_TYPE: Joi.string()
          .valid('sqlite', 'postgres')
          .default('sqlite'),
        DATABASE_SCHEMA: Joi.string()
          .when('DATABASE_TYPE', {
            is: 'sqlite',
            then: Joi.string().default((parent) =>
              path.join(parent.DATA_PATH, 'sqlite3.db'),
            ),
          })
          .when('DATABASE_TYPE', {
            is: 'postgres',
            then: Joi.string().required(),
          }),
        DATABASE_HOST: Joi.string().when('DATABASE_TYPE', {
          is: 'postgres',
          then: Joi.string().required(),
          otherwise: Joi.optional(),
        }),
        DATABASE_PORT: Joi.number().when('DATABASE_TYPE', {
          is: 'postgres',
          then: Joi.number().required(),
          otherwise: Joi.optional(),
        }),
        DATABASE_USER: Joi.string().when('DATABASE_TYPE', {
          is: 'postgres',
          then: Joi.string().required(),
          otherwise: Joi.optional(),
        }),
        DATABASE_PASS: Joi.string().when('DATABASE_TYPE', {
          is: 'postgres',
          then: Joi.string().required(),
          otherwise: Joi.optional(),
        }),
        DATABASE_SSL: Joi.boolean().when('DATABASE_TYPE', {
          is: 'postgres',
          then: Joi.boolean().default(false),
          otherwise: Joi.optional(),
        }),
        FILE_STORAGE_TYPE: Joi.string()
          .valid('local', 'object')
          .default('local'),
        OBJECT_STORAGE_BUCKET_NAME: Joi.string().when('FILE_STORAGE_TYPE', {
          is: 'object',
          then: Joi.string().required(),
          otherwise: Joi.optional(),
        }),
        OBJECT_STORAGE_ACCESS_KEY_ID: Joi.string().when('FILE_STORAGE_TYPE', {
          is: 'object',
          then: Joi.string().required(),
          otherwise: Joi.optional(),
        }),
        OBJECT_STORAGE_SECRET_ACCESS_KEY: Joi.string().when(
          'FILE_STORAGE_TYPE',
          {
            is: 'object',
            then: Joi.string().required(),
            otherwise: Joi.optional(),
          },
        ),
        OBJECT_STORAGE_ENDPOINT: Joi.string().when('FILE_STORAGE_TYPE', {
          is: 'object',
          then: Joi.string().required(),
          otherwise: Joi.optional(),
        }),
        OBJECT_STORAGE_REGION: Joi.string().when('FILE_STORAGE_TYPE', {
          is: 'object',
          then: Joi.string().default('us-east-1'),
          otherwise: Joi.optional(),
        }),
        // Nightly storage reconciliation (MaintenanceModule). Off in the
        // integration harness; `npm run maintenance:reconcile` runs it once
        // regardless.
        MAINTENANCE_ENABLED: Joi.boolean().default(true),
        // HEIC uploads are decoded in memory before sharp sees them; a part
        // larger than this is a 413.
        MAX_HEIC_BYTES: Joi.number()
          .integer()
          .min(1)
          .default(40 * 1024 * 1024),
      }),
      validationOptions: {
        abortEarly: true,
      },
      isGlobal: true,
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      resolvers: [AcceptLanguageResolver],
      loaderOptions: {
        path: path.join(__dirname, '/i18n/'),
        watch: process.env.NODE_ENV === 'development',
      },
      // Live-reloading and regenerating src/i18n/generated/ are development
      // conveniences only: production must not watch, and parallel test
      // workers must not race to rewrite a source file.
      typesOutputPath:
        process.env.NODE_ENV === 'development'
          ? path.join(__dirname, '../src/i18n/generated/i18n.generated.ts')
          : undefined,
      viewEngine: 'hbs',
    }),
    MikroOrmModule.forFeature([User]),
    // https://docs.nestjs.com/security/rate-limiting
    ThrottlerModule.forRoot(),
    DalModule,
    AuthModule,
    FileModule,
    EmailModule,
    NotificationModule,
    OpenGraphModule,
    WardrobeModule,
    WardrobeShareModule,
    ViewContextModule,
    MaintenanceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // https://docs.nestjs.com/security/rate-limiting#rate-limiting
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: ErrorViewFilter,
    },
  ],
})
export class AppModule implements OnModuleInit {
  public logger = new Logger(AppModule.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log(`NODE_ENV: ${this.configService.get('NODE_ENV')}`);
    this.logger.log(`DATA_PATH: ${this.configService.get('DATA_PATH')}`);
    await this.orm.migrator.up();
  }
}
