import { SerialValidationClient } from './serial-validation.client';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateAggregationEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './persistence/prisma.service';
import { AggregationService } from './aggregation.service';
import { AggregationController } from './aggregation.controller';
import { InternalIdentityGuard } from './authorization';
import { HealthController } from './health.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateAggregationEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createLoggerOptions(
          'aggregation-service',
          config.getOrThrow<string>('LOG_LEVEL'),
        ),
      }),
    }),
  ],
  controllers: [AggregationController, HealthController],
  providers: [
    PrismaService,
    AggregationService,
    SerialValidationClient,
    InternalIdentityGuard,
  ],
})
export class AppModule {}
