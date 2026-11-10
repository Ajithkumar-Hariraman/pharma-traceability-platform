import {
  Messaging,
  toTrace,
  OutboxPublisher,
  PostgresOutboxStore,
} from '@pharma/messaging';
import { TraceCaptureClient } from '../trace-capture.client';
import { validateOutboxEnvironment } from '@pharma/config';
import {
  Injectable,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AggregationEnvironment } from '@pharma/config';
import { PrismaClient } from '../../generated/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  readonly outbox?: OutboxPublisher;
  constructor(
    config: ConfigService<AggregationEnvironment, true>,
    @Optional() messaging?: Messaging,
  ) {
    super({
      datasources: { db: { url: config.get('DATABASE_URL', { infer: true }) } },
    });
    this.outbox = new OutboxPublisher(
      new PostgresOutboxStore(this),
      messaging?.enabled
        ? messaging
        : {
            publish: (event) =>
              new TraceCaptureClient(config).capture(toTrace(event)),
          },
      validateOutboxEnvironment(
        Object.fromEntries(
          (
            [
              'OUTBOX_POLL_INTERVAL_MS',
              'OUTBOX_BATCH_SIZE',
              'OUTBOX_MAX_ATTEMPTS',
              'OUTBOX_RETRY_BASE_MS',
              'OUTBOX_RETRY_MAX_MS',
              'OUTBOX_LEASE_MS',
              'OUTBOX_RETENTION_DAYS',
            ] as const
          ).map((key) => [key, config.get(key)]),
        ),
      ),
      'aggregation-service',
    );
  }
  onApplicationBootstrap() {
    this.outbox?.start();
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.outbox?.stop();
    await this.$disconnect();
  }
}
