import { JwtModule } from '@nestjs/jwt';
import { AuthController, AccessGuard } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { PasswordService } from './auth/password.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateAuthEnvironment, type AuthEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './health.controller';
import { PrismaService } from './persistence/prisma.service';
import { DatabaseRepository } from './persistence/database.repository';
import { UserRepository } from './users/user.repository';
import { UserService } from './users/user.service';
import { ReadinessService } from './readiness.service';
import { ReadinessController } from './readiness.controller';
@Module({
  imports: [
    JwtModule.register({}),
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env: Record<string, unknown>) => validateAuthEnvironment(env),
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AuthEnvironment, true>) => ({
        pinoHttp: createLoggerOptions(
          'auth-service',
          config.get('LOG_LEVEL', { infer: true }),
        ),
      }),
    }),
  ],
  controllers: [HealthController, ReadinessController, AuthController],
  providers: [
    AuthService,
    PasswordService,
    AccessGuard,
    PrismaService,
    DatabaseRepository,
    UserRepository,
    UserService,
    ReadinessService,
  ],
})
export class AppModule {}
