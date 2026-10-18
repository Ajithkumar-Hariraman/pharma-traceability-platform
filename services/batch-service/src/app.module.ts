import { BatchReferenceController } from './batch-reference.controller';
import { ProductValidationClient } from './product-validation.client';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateBatchEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './persistence/prisma.service';
import { BatchRepository } from './batch.repository';
import { BatchService } from './batch.service';
import { BatchController } from './batch.controller';
import { InternalIdentityGuard } from './authorization';
import { HealthController } from './health.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateBatchEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createLoggerOptions(
          'batch-service',
          config.getOrThrow<string>('LOG_LEVEL'),
        ),
      }),
    }),
  ],
  controllers: [BatchController, BatchReferenceController, HealthController],
  providers: [
    PrismaService,
    BatchRepository,
    BatchService,
    ProductValidationClient,
    InternalIdentityGuard,
  ],
})
export class AppModule {}
