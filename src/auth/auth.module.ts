import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthContextService } from './auth-context.service';
import { RegistrationGuard } from './registration.guard';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { User } from '../dal/entity/user.entity';
import { FileModule } from '../file/file.module';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('ACCESS_TOKEN_SECRET'),
        signOptions: { expiresIn: '365d' },
      }),
    }),
    MikroOrmModule.forFeature([User]),
    // Account deletion removes the user's photos through FileService.
    FileModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthContextService, RegistrationGuard],
  exports: [JwtModule, AuthService, AuthContextService],
})
export class AuthModule {}
