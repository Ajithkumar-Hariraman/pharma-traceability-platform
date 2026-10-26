import { AggregationController } from './aggregation/aggregation.controller';
import { AggregationProxy } from './aggregation/aggregation-proxy';
import { SerializationController } from './serialization/serialization.controller';
import { SerializationProxy } from './serialization/serialization-proxy';
import { BatchController } from './batches/batch.controller';
import { BatchProxy } from './batches/batch-proxy';
import { ProductController } from './products/product.controller';
import { ProductProxy } from './products/product-proxy';
import { OrganizationController } from './organizations/organization.controller';
import {
  OrganizationProxy,
  GatewayIdentityGuard,
} from './organizations/organization-proxy';
import { AuthController } from './auth/auth.controller';
import { AuthProxyService } from './auth/auth-proxy.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  validateGatewayEnvironment,
  type GatewayEnvironment,
} from '@pharma/config';
import { createLoggerOptions } from '@pharma/logger';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './health.controller';
import { AuthHealthService } from './auth/auth-health.service';
import { AuthHealthController } from './auth/auth-health.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env: Record<string, unknown>) =>
        validateGatewayEnvironment(env),
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnvironment, true>) => ({
        pinoHttp: createLoggerOptions(
          'api-gateway',
          config.get('LOG_LEVEL', { infer: true }),
        ),
      }),
    }),
  ],
  controllers: [
    HealthController,
    AuthHealthController,
    AuthController,
    OrganizationController,
    ProductController,
    BatchController,
    SerializationController,
    AggregationController,
  ],
  providers: [
    AuthHealthService,
    AuthProxyService,
    OrganizationProxy,
    ProductProxy,
    BatchProxy,
    SerializationProxy,
    AggregationProxy,
    GatewayIdentityGuard,
  ],
})
export class AppModule {}
