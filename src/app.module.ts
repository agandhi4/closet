import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import * as path from 'path';
import { SessionGuard } from './auth/session.guard';
import { DbModule } from './db/db.module';
import { I18nModule } from 'nestjs-i18n';
import { LoggerModule } from 'nestjs-pino';
import { ErrorViewFilter } from './error-view.filter';
import { ViewContextModule } from './view-context/view-context.module';
import { isStaticPath } from './static-prefixes';
import { type Env, loadConfig } from './config';

// Nest mounts pino-http as middleware, which strips the mount prefix from
// req.url ("/healthz" arrives as "/"); the full path is in originalUrl.
function originalUrl(req: IncomingMessage): string {
  return 'originalUrl' in req && typeof req.originalUrl === 'string'
    ? req.originalUrl
    : (req.url ?? '');
}

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
    // The schema, defaults and rules are src/config.ts; ConfigModule only
    // hands it the merged environment (.env.local, .env, process.env).
    ConfigModule.forRoot({
      envFilePath: ['.env.local', '.env'],
      validate: (env) => loadConfig({ env: env as Env, envFiles: [] }),
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
