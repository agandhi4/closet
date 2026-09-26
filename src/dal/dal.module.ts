import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

// Query output goes through the app logger so it follows LOG_LEVEL and
// pino's formatting (colors off: pino-pretty adds its own).
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
        driverOptions: {
          connection: {
            ssl: configService.get<boolean>('DATABASE_SSL')
              ? { rejectUnauthorized: false }
              : undefined,
          },
        },
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
