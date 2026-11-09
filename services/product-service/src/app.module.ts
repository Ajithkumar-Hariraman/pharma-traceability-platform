import { DocumentController } from './document.controller';
import { validateStorageEnvironment } from '@pharma/config';
import { ProductReferenceController } from './product-reference.controller';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateProductEnvironment } from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './persistence/prisma.service';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { InternalIdentityGuard } from './authorization';
import { HealthController } from './health.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (input) => ({
        ...validateProductEnvironment(input),
        storage: validateStorageEnvironment(input),
      }),
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createLoggerOptions(
          'product-service',
          config.getOrThrow<string>('LOG_LEVEL'),
        ),
      }),
    }),
  ],
  controllers: [
    DocumentController,
    ProductController,
    ProductReferenceController,
    HealthController,
  ],
  providers: [
    PrismaService,
    ProductRepository,
    ProductService,
    InternalIdentityGuard,
  ],
})
export class AppModule {}
