import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, type Db, type DbConfig, type DbLogger } from './client';
import { runMigrations } from './migrate';

/** Injection token for the Drizzle instance: `@Inject(DB) db: Db`. */
export const DB = Symbol('DB');

function dbConfig(configService: ConfigService): DbConfig {
  return {
    host: configService.getOrThrow<string>('DATABASE_HOST'),
    port: configService.getOrThrow<number>('DATABASE_PORT'),
    database: configService.getOrThrow<string>('DATABASE_SCHEMA'),
    user: configService.getOrThrow<string>('DATABASE_USER'),
    password: configService.getOrThrow<string>('DATABASE_PASS'),
    ssl: configService.get<boolean>('DATABASE_SSL') ?? false,
  };
}

function dbLogger(context: string): DbLogger {
  const logger = new Logger(context);
  return {
    info: (message) => logger.log(message),
    error: (message, error) =>
      logger.error(
        message,
        error instanceof Error ? error.stack : String(error),
      ),
  };
}

/**
 * Nest's handle on src/db: the Drizzle instance for ported code, and the
 * boot-time migrations. Global, so a feature module injects DB without
 * importing this module, and so its onModuleInit runs before every
 * non-global module's (Nest gives global modules the greatest distance) and
 * before any onApplicationBootstrap: the schema is
 * current before anything queries it.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Db =>
        createDb(dbConfig(configService), dbLogger('Db')),
    },
  ],
  exports: [DB],
})
export class DbModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await runMigrations(dbConfig(this.configService), dbLogger('Migrations'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.$client.end();
  }
}
