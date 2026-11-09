import { DocumentController } from './document.controller';
import { validateStorageEnvironment } from '@pharma/config';
import { MessagingModule } from '@pharma/messaging';
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
    MessagingModule.forOutbox(),
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (input) => ({
        ...validateShipmentEnvironment(input),
        storage: validateStorageEnvironment(input),
      }),
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
  controllers: [DocumentController, ShipmentController, HealthController],
  providers: [
    PrismaService,
    ShipmentService,
    ReferenceClient,
    TraceCaptureClient,
    InternalIdentityGuard,
  ],
})
export class AppModule {}
