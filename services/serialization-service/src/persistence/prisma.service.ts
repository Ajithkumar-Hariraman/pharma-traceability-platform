import {
  Messaging,
  OutboxPublisher,
  PostgresOutboxStore,
} from '@pharma/messaging';
import { validateOutboxEnvironment } from '@pharma/config';
import {
  Injectable,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SerializationEnvironment } from '@pharma/config';
import { PrismaClient } from '../../generated/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  readonly outbox?: OutboxPublisher;
  constructor(
    config: ConfigService<SerializationEnvironment, true>,
    @Optional() messaging?: Messaging,
  ) {
    super({
      datasources: { db: { url: config.get('DATABASE_URL', { infer: true }) } },
    });
    if (messaging?.enabled)
      this.outbox = new OutboxPublisher(
        new PostgresOutboxStore(this),
        messaging,
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
        'serialization-service',
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
