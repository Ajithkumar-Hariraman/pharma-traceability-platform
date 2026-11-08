import { Injectable, Logger, Optional } from '@nestjs/common';
import { Messaging, type DomainEvent } from '@pharma/messaging';
import { VerificationCache } from './verification-cache.store';
import { VerificationProjection } from './verification-projection';
import { VerificationService } from './verification.service';
@Injectable()
export class VerificationInvalidationConsumer {
  private readonly logger = new Logger('VerificationInvalidation');
  private stopping = false;
  private retry?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly messaging: Messaging,
    private readonly cache: VerificationCache,
    @Optional() private readonly projection?: VerificationProjection,
    @Optional() private readonly verification?: VerificationService,
  ) {}
  onApplicationBootstrap() {
    void this.start();
  }
  private async start() {
    try {
      await this.messaging.consume(
        (event) => this.handle(event),
        'verification-invalidation-v1',
      );
    } catch {
      this.logger.warn({
        message: 'Verification invalidation consumer unavailable; retrying',
        invalidationDegraded: true,
      });
      if (!this.stopping) {
        this.retry = setTimeout(() => {
          void this.start();
        }, 3000);
        this.retry.unref();
      }
    }
  }
  async handle(event: DomainEvent) {
    try {
      await this.cache.invalidate(event);
    } catch {
      this.logger.warn({
        message: 'Redis invalidation failed before projection; will retry',
        eventId: event.eventId,
      });
    }
    if (this.projection && this.verification) {
      await this.projection.consume(event, (identity, input, source) =>
        this.verification!.authoritative(identity, input, source),
      );
    }
    // Failure here retains the Kafka offset for retry, after durable projection work.
    await this.cache.invalidate(event);
  }
  onModuleDestroy() {
    this.stopping = true;
    if (this.retry) clearTimeout(this.retry);
  }
}
