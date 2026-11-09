import { DocumentController } from './document.controller';
import { validateStorageEnvironment } from '@pharma/config';
import { VerificationInvalidationConsumer } from './verification-consumer';
import { DynamoStore } from '@pharma/dynamodb';
import { VerificationProjection } from './verification-projection';
import { RedisModule } from '@pharma/redis';
import { VerificationCache } from './verification-cache';
import { MessagingModule } from '@pharma/messaging';
import { ReferenceClient } from './reference.client';
import { VerificationService } from './verification.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateRecallEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './persistence/prisma.service';
import { RecallService } from './recall.service';
import { RecallController } from './recall.controller';
import { InternalIdentityGuard } from './authorization';
import { HealthController } from './health.controller';
@Module({
  imports: [
    MessagingModule.forOutbox(),
    RedisModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (input) => ({
        ...validateRecallEnvironment(input),
        storage: validateStorageEnvironment(input),
      }),
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createLoggerOptions(
          'recall-service',
          config.getOrThrow<string>('LOG_LEVEL'),
        ),
      }),
    }),
  ],
  controllers: [DocumentController, RecallController, HealthController],
  providers: [
    PrismaService,
    RecallService,
    ReferenceClient,
    VerificationService,
    DynamoStore,
    VerificationProjection,
    VerificationCache,
    VerificationInvalidationConsumer,
    InternalIdentityGuard,
  ],
})
export class AppModule {}
