import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateTraceabilityEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './persistence/prisma.service';
import { HealthController } from './health.controller';
import { TraceService } from './trace.service';
import { TraceController, CaptureController } from './trace.controller';
import { TraceGuard } from './trace.guard';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateTraceabilityEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createLoggerOptions(
          'traceability-service',
          config.getOrThrow<string>('LOG_LEVEL'),
        ),
      }),
    }),
  ],
  controllers: [HealthController, TraceController, CaptureController],
  providers: [PrismaService, TraceService, TraceGuard],
})
export class AppModule {}
