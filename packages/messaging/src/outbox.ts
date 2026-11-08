import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { eventSchema, type DomainEvent } from './index';
import type { OutboxEnvironment } from '@pharma/config';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export interface OutboxTransaction {
  outboxEvent: {
    create(args: {
      data: {
        id: string;
        eventId: string;
        eventType: string;
        eventVersion: number;
        organizationId: string;
        aggregateType: string;
        aggregateId: string;
        envelope: { [key: string]: Json };
      };
    }): Promise<unknown>;
  };
}
/** Must be called with the SAME transaction client that mutates business state. */
export async function enqueueEvent(tx: OutboxTransaction, input: DomainEvent) {
  const event = eventSchema.parse(input);
  await tx.outboxEvent.create({
    data: {
      id: randomUUID(),
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      envelope: JSON.parse(JSON.stringify(event)),
    },
  });
}
export interface OutboxDatabase {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
}
export interface OutboxRow {
  id: string;
  eventId: string;
  eventType: string;
  organizationId: string;
  aggregateId: string;
  envelope: unknown;
  attempts: number;
  claimToken: string;
}
export class PostgresOutboxStore {
  constructor(private readonly db: OutboxDatabase) {}
  async claim(settings: OutboxEnvironment): Promise<OutboxRow[]> {
    // An expired final attempt remains durable and visible for operator requeue.
    await this.db
      .$executeRaw`UPDATE "OutboxEvent" SET status = 'FAILED', "claimToken" = NULL, "lastError" = 'RETRY_LIMIT_EXHAUSTED', "updatedAt" = clock_timestamp() WHERE status IN ('PENDING', 'PUBLISHING') AND "availableAt" <= clock_timestamp() AND attempts >= ${settings.OUTBOX_MAX_ATTEMPTS}`;
    const token = randomUUID();
    return this.db.$queryRaw<OutboxRow[]>`
      WITH eligible AS (
        SELECT id FROM "OutboxEvent"
        WHERE status IN ('PENDING', 'PUBLISHING') AND "availableAt" <= clock_timestamp()
          AND attempts < ${settings.OUTBOX_MAX_ATTEMPTS}
        ORDER BY "createdAt", id FOR UPDATE SKIP LOCKED LIMIT ${settings.OUTBOX_BATCH_SIZE}
      )
      UPDATE "OutboxEvent" o SET status = 'PUBLISHING', attempts = attempts + 1,
        "claimToken" = ${token}::uuid,
        "availableAt" = clock_timestamp() + ${settings.OUTBOX_LEASE_MS} * interval '1 millisecond',
        "updatedAt" = clock_timestamp()
      FROM eligible WHERE o.id = eligible.id RETURNING o.*`;
  }
  renew(token: string, leaseMs: number) {
    return this.db
      .$executeRaw`UPDATE "OutboxEvent" SET "availableAt" = clock_timestamp() + ${leaseMs} * interval '1 millisecond', "updatedAt" = clock_timestamp() WHERE status = 'PUBLISHING' AND "claimToken" = ${token}::uuid`;
  }
  release(row: OutboxRow) {
    return this.db
      .$executeRaw`UPDATE "OutboxEvent" SET status = 'PENDING', attempts = GREATEST(attempts - 1, 0), "availableAt" = clock_timestamp(), "claimToken" = NULL, "updatedAt" = clock_timestamp() WHERE id = ${row.id}::uuid AND status = 'PUBLISHING' AND "claimToken" = ${row.claimToken}::uuid`;
  }
  published(row: OutboxRow) {
    return this.db
      .$executeRaw`UPDATE "OutboxEvent" SET status = 'PUBLISHED', "publishedAt" = clock_timestamp(), "claimToken" = NULL, "lastError" = NULL, "updatedAt" = clock_timestamp() WHERE id = ${row.id}::uuid AND status = 'PUBLISHING' AND "claimToken" = ${row.claimToken}::uuid`;
  }
  retry(row: OutboxRow, delayMs: number, exhausted: boolean) {
    // Persist only a fixed error code; broker errors may contain credentials/payloads.
    return this.db
      .$executeRaw`UPDATE "OutboxEvent" SET status = ${exhausted ? 'FAILED' : 'PENDING'}::"OutboxStatus", "availableAt" = clock_timestamp() + ${delayMs} * interval '1 millisecond', "claimToken" = NULL, "lastError" = 'PUBLISH_FAILED', "updatedAt" = clock_timestamp() WHERE id = ${row.id}::uuid AND status = 'PUBLISHING' AND "claimToken" = ${row.claimToken}::uuid`;
  }
  cleanup(retentionDays: number, batchSize: number) {
    return this.db.$executeRaw`
      WITH expired AS (
        SELECT id FROM "OutboxEvent" WHERE status = 'PUBLISHED'
          AND "publishedAt" < clock_timestamp() - ${retentionDays} * interval '1 day'
        ORDER BY "publishedAt", id FOR UPDATE SKIP LOCKED LIMIT ${batchSize}
      ) DELETE FROM "OutboxEvent" o USING expired WHERE o.id = expired.id`;
  }
}
export class OutboxPublisher {
  private readonly logger = new Logger('OutboxPublisher');
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopping = false;
  private inFlight?: Promise<void>;
  private lastPollAt?: Date;
  private storageAvailable = false;
  constructor(
    private readonly store: PostgresOutboxStore,
    private readonly messaging: {
      publish(event: DomainEvent): Promise<unknown>;
    },
    private readonly settings: OutboxEnvironment,
    private readonly producer: string,
  ) {}
  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    const poll = () => {
      if (!this.running) return;
      this.inFlight = this.runOnce()
        .catch(() => {
          this.storageAvailable = false;
          this.logger.error({
            message: 'Outbox poll failed',
            producer: this.producer,
            code: 'OUTBOX_STORAGE_UNAVAILABLE',
          });
        })
        .finally(() => {
          if (this.running)
            this.timer = setTimeout(
              poll,
              this.settings.OUTBOX_POLL_INTERVAL_MS,
            );
        });
    };
    this.timer = setTimeout(poll, 0);
  }
  status() {
    return {
      running: this.running,
      storageAvailable: this.storageAvailable,
      lastPollAt: this.lastPollAt,
    };
  }
  async stop() {
    this.stopping = true;
    this.running = false;
    clearTimeout(this.timer);
    await this.inFlight;
  }
  async runOnce() {
    const rows = await this.store.claim(this.settings);
    this.lastPollAt = new Date();
    this.storageAvailable = true;
    const token = rows[0]?.claimToken;
    // Renew the entire bounded batch, including queued sends, while publishing.
    let renewal: Promise<unknown> = Promise.resolve();
    const timer = token
      ? setInterval(
          () => {
            renewal = renewal
              .then(() =>
                this.store.renew(token, this.settings.OUTBOX_LEASE_MS),
              )
              .catch(() => {
                this.logger.warn({
                  message: 'Outbox lease renewal failed',
                  producer: this.producer,
                });
              });
          },
          Math.floor(this.settings.OUTBOX_LEASE_MS / 3),
        )
      : undefined;
    try {
      for (const row of rows) {
        if (this.stopping) {
          await this.store.release(row);
          continue;
        }
        const context = {
          eventId: row.eventId,
          eventType: row.eventType,
          aggregateId: row.aggregateId,
          organizationId: row.organizationId,
          attempt: row.attempts,
          producer: this.producer,
        };
        try {
          const event = eventSchema.parse(row.envelope);
          if (
            event.eventId !== row.eventId ||
            event.organizationId !== row.organizationId ||
            event.aggregateId !== row.aggregateId ||
            event.eventType !== row.eventType ||
            event.producer !== this.producer
          )
            throw new Error('Outbox envelope mismatch');
          await this.messaging.publish(event);
        } catch {
          const exhausted = row.attempts >= this.settings.OUTBOX_MAX_ATTEMPTS;
          const delay = Math.min(
            this.settings.OUTBOX_RETRY_MAX_MS,
            this.settings.OUTBOX_RETRY_BASE_MS *
              2 ** Math.min(row.attempts - 1, 30),
          );
          await this.store.retry(row, delay, exhausted);
          this.logger.warn({
            message: 'Outbox publish failed',
            ...context,
            exhausted,
          });
          continue;
        }
        // A failure here leaves a lease for recovery; replay uses the same eventId.
        const updated = await this.store.published(row);
        this.logger.log({
          message: 'Outbox acknowledged',
          ...context,
          claimRetained: updated === 1,
        });
      }
    } finally {
      clearInterval(timer);
      await renewal;
    }
    await this.store.cleanup(
      this.settings.OUTBOX_RETENTION_DAYS,
      this.settings.OUTBOX_BATCH_SIZE,
    );
    this.lastPollAt = new Date();
    this.storageAvailable = true;
  }
}
