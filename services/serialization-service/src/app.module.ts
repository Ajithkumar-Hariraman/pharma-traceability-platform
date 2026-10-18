import { BatchValidationClient } from './batch-validation.client';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateSerializationEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './persistence/prisma.service';
import { SerializationRepository } from './serialization.repository';
import { SerializationService } from './serialization.service';
import { SerializationController } from './serialization.controller';
import { InternalIdentityGuard } from './authorization';
import { HealthController } from './health.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateSerializationEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createLoggerOptions(
          'serialization-service',
          config.getOrThrow<string>('LOG_LEVEL'),
        ),
      }),
    }),
  ],
  controllers: [SerializationController, HealthController],
  providers: [
    PrismaService,
    SerializationRepository,
    SerializationService,
    BatchValidationClient,
    InternalIdentityGuard,
  ],
})
export class AppModule {}
