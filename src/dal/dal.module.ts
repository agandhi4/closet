import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import path from 'path';

// Query and migrator output goes through the app logger so it follows
// LOG_LEVEL and pino's formatting (colors off: pino-pretty adds its own).
const ormLogger = new Logger('MikroORM');

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        driver: PostgreSqlDriver,
        dbName: configService.getOrThrow<string>('DATABASE_SCHEMA'),
        host: configService.getOrThrow<string>('DATABASE_HOST'),
        port: configService.getOrThrow<number>('DATABASE_PORT'),
        user: configService.getOrThrow<string>('DATABASE_USER'),
        password: configService.getOrThrow<string>('DATABASE_PASS'),
        autoLoadEntities: true,
        extensions: [Migrator],
        migrations: {
          pattern: /^.*\.(js|ts)$/, // ends with .js or .ts
          path: path.join(__dirname, 'migrations/postgres'),
          pathTs: path.join(__dirname, 'migrations/postgres'),
          transactional: true,
          // One transaction per migration, not one around the whole pending
          // batch. Index migrations opt out of transactions (CREATE INDEX
          // CONCURRENTLY) and then run on a second connection, which under a
          // batch-wide transaction cannot see tables created earlier in the
          // same batch: a fresh database (CI, first boot) would fail on
          // "relation does not exist". Keep in sync with
          // mikro-orm.postgres.cli-config.ts.
          allOrNothing: false,
          // Snapshots serve migration:create, which runs through
          // mikro-orm.postgres.cli-config.ts; the runtime must not write
          // .snapshot-*.json next to the migrations on every boot.
          snapshot: false,
        },
        driverOptions: {
          connection: {
            ssl: configService.get<boolean>('DATABASE_SSL')
              ? { rejectUnauthorized: false }
              : undefined,
          },
        },
        // Migrations are discovered by path and loaded through this. MikroORM's
        // default is an import() inside its own package, which under Vitest
        // bypasses the test transform: Node loads the .ts file itself and
        // fails on anything type stripping cannot (an extensionless import of
        // src/ code). An import() in our source is compiled with the app:
        // require() in dist/, Vitest's module runner in tests.
        dynamicImportProvider: (id: string) => import(id),
        logger: (message: string) => ormLogger.log(message),
        colors: false,
        allowGlobalContext: true,
        debug: configService.get('NODE_ENV') === 'development',
      }),
      // mikro-orm/nestjs#204: the driver must be known statically, before
      // the factory runs, for the module to register the right EntityManager.
      driver: PostgreSqlDriver,
    }),
  ],
})
export class DalModule implements OnModuleInit {
  private logger = new Logger(DalModule.name);

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.logger.log(
      `Using postgres db: ${this.configService.get('DATABASE_SCHEMA')}, host: ${this.configService.get('DATABASE_HOST')}`,
    );
  }
}
