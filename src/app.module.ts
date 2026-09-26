import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import Joi from 'joi';
import type { IncomingMessage } from 'node:http';
import * as path from 'path';
import { SessionGuard } from './auth/session.guard';
import { DalModule } from './dal/dal.module';
import { DbModule } from './db/db.module';
import { I18nModule } from 'nestjs-i18n';
import { LoggerModule } from 'nestjs-pino';
import { ErrorViewFilter } from './error-view.filter';
import { ViewContextModule } from './view-context/view-context.module';
import { isStaticPath } from './static-prefixes';
import { isValidTimeZone } from './web/calendar/calendar-date';

// Nest mounts pino-http as middleware, which strips the mount prefix from
// req.url ("/healthz" arrives as "/"); the full path is in originalUrl.
function originalUrl(req: IncomingMessage): string {
  return 'originalUrl' in req && typeof req.originalUrl === 'string'
    ? req.originalUrl
    : (req.url ?? '');
}

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
            // The session cookie is a bearer credential: a logged header is a
            // stolen login for a year. app.log lives under DATA_PATH and the
            // container logs reach Loki, so neither may ever hold one.
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            // Every thumbnail, script and 30 s heartbeat was a log line: noise
            // that cost ~16% of image throughput. Failures on these paths
            // still surface through ErrorViewFilter.
            autoLogging: {
              ignore: (req) => isStaticPath(originalUrl(req)),
            },
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
        // integration harness uses so test output is only Vitest's.
        LOG_LEVEL: Joi.string()
          .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent')
          .default('info'),
        // Comma-separated IPs/CIDRs whose X-Forwarded-* headers are trusted
        // (Fastify trustProxy): the client IP the rate limits count and the
        // origin the same-origin check compares. Behind a reverse proxy it
        // must include the proxy's address. Consumed in app.ts before the
        // app exists.
        TRUSTED_PROXIES: Joi.string().default(DEFAULT_TRUSTED_PROXIES),
        APP_NAME: Joi.string().default('Closet'),
        // The household's IANA time zone: it decides what "today" is on the
        // calendar and which week opens by default. One zone, because one
        // household shares the calendar; an unknown name fails the boot.
        APP_TIMEZONE: Joi.string()
          .custom((value: string, helpers) =>
            isValidTimeZone(value) ? value : helpers.error('any.invalid'),
          )
          .default('America/New_York'),
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
        // Also the VAPID subject of Web Push (src/web/push/sender.ts), which
        // web-push requires to be https: when PWA_ENABLED is true.
        SITE_URL: Joi.string().default('http://localhost:3000'),
        // File under public/assets/ used for apple-touch-icon, Open Graph
        // previews and the share-link watermark.
        ICON_NAME: Joi.string().default('icon.png'),
        // Composite the app icon onto share-link Open Graph images.
        WATERMARK_ENABLED: Joi.boolean().default(false),
        DATA_PATH: Joi.string().default(path.join(process.cwd(), 'data')),
        // Postgres is the only database (SQLite was dropped 2026-09-25: its
        // tests passed on behavior production never had). No defaults on
        // purpose: a missing value must fail the boot, not reach localhost.
        DATABASE_HOST: Joi.string().required(),
        DATABASE_PORT: Joi.number().default(5432),
        DATABASE_SCHEMA: Joi.string().required(),
        DATABASE_USER: Joi.string().required(),
        // Empty is valid: pgvault-dev and the test databases use trust auth.
        DATABASE_PASS: Joi.string().allow('').required(),
        DATABASE_SSL: Joi.boolean().default(false),
        // Nightly storage reconciliation at 03:00 APP_TIMEZONE, scheduled by
        // the server (main.ts); `npm run maintenance:reconcile` runs it once
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
    // English only (owner decision 2026-09-26): no language resolver, one
    // catalog. Kept only for the Handlebars views still in Nest; JSX views use
    // src/web/i18n.ts. Live reload is a development convenience.
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: {
        path: path.join(__dirname, '/i18n/'),
        watch: process.env.NODE_ENV === 'development',
      },
      viewEngine: 'hbs',
    }),
    // Runs the migrations (src/db/migrate.ts) before anything queries.
    DbModule,
    DalModule,
    ViewContextModule,
  ],
  providers: [
    // Login is always required: every Nest route needs a session unless it
    // is @Public() (see SessionGuard). Rate limits are per route, in the
    // web layer (src/web/security/rate-limit.ts).
    {
      provide: APP_GUARD,
      useClass: SessionGuard,
    },
    {
      provide: APP_FILTER,
      useClass: ErrorViewFilter,
    },
  ],
})
export class AppModule implements OnModuleInit {
  public logger = new Logger(AppModule.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.logger.log(`NODE_ENV: ${this.configService.get('NODE_ENV')}`);
    this.logger.log(`DATA_PATH: ${this.configService.get('DATA_PATH')}`);
  }
}
