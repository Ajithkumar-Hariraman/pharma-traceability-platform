import { ReferenceClient } from './reference.client';
import { TraceCaptureClient } from './trace-capture.client';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateShipmentEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './persistence/prisma.service';
import { ShipmentService } from './shipment.service';
import { ShipmentController } from './shipment.controller';
import { InternalIdentityGuard } from './authorization';
import { HealthController } from './health.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateShipmentEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createLoggerOptions(
          'shipment-service',
          config.getOrThrow<string>('LOG_LEVEL'),
        ),
      }),
    }),
  ],
  controllers: [ShipmentController, HealthController],
  providers: [
    PrismaService,
    ShipmentService,
    ReferenceClient,
    TraceCaptureClient,
    InternalIdentityGuard,
  ],
})
export class AppModule {}
