import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisStore } from '@pharma/redis';
import { eventSchema } from '@pharma/messaging';
import { validateRedisEnvironment } from '@pharma/config';
import { type VerificationResult } from '@pharma/contracts';
import { cachedVerificationSchema } from './verification-result.schema';
export { cachedVerificationSchema } from './verification-result.schema';

@Injectable()
export class VerificationCache {
  private readonly logger = new Logger('VerificationCache');
  readonly settings;
  constructor(
    private readonly redis: RedisStore,
    config: ConfigService,
  ) {
    this.settings = validateRedisEnvironment(
      Object.fromEntries(
        [
          'REDIS_URL',
          'VERIFICATION_CACHE_TTL_SECONDS',
          'VERIFICATION_UNKNOWN_TTL_SECONDS',
          'VERIFICATION_RATE_LIMIT',
          'VERIFICATION_RATE_WINDOW_SECONDS',
        ].map((k) => [k, config.get(k)]),
      ),
    );
  }
  private scope(org: string) {
    return `verification:v1:${org}:generation`;
  }
  async key(org: string, gtin: string, serial: string) {
    const generation = await this.redis.generation(
      this.scope(org),
      randomUUID(),
    );
    const digest = createHash('sha256')
      .update(JSON.stringify([gtin, serial]))
      .digest('hex');
    return `verification:v1:${org}:${generation}:${digest}`;
  }
  async read(
    key: string,
    gtin: string,
    serial: string,
  ): Promise<VerificationResult | undefined> {
    const raw = await this.redis.get(key);
    if (!raw) return;
    try {
      const value = cachedVerificationSchema.parse(JSON.parse(raw));
      const age = Date.now() - Date.parse(value.verifiedAt);
      const ttl =
        value.result === 'UNKNOWN'
          ? this.settings.VERIFICATION_UNKNOWN_TTL_SECONDS
          : this.settings.VERIFICATION_CACHE_TTL_SECONDS;
      if (
        value.gtin !== gtin ||
        value.serialNumber !== serial ||
        age < 0 ||
        age >= ttl * 1000 ||
        (value.result === 'VALID' &&
          value.expiryDate &&
          value.expiryDate < new Date().toISOString().slice(0, 10))
      )
        throw new Error();
      return value;
    } catch {
      this.logger.warn({
        message: 'Malformed verification cache entry ignored',
        cacheScope: 'verification',
      });
      await this.redis.del(key);
    }
  }
  async write(key: string, value: VerificationResult) {
    await this.redis.set(
      key,
      JSON.stringify(value),
      value.result === 'UNKNOWN'
        ? this.settings.VERIFICATION_UNKNOWN_TTL_SECONDS
        : this.settings.VERIFICATION_CACHE_TTL_SECONDS,
    );
  }
  async invalidateOrganization(org: string) {
    await this.redis.rotate(this.scope(org), randomUUID());
  }
  async invalidate(input: unknown) {
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) {
      this.logger.warn({ message: 'Malformed invalidation event ignored' });
      return;
    }
    const event = parsed.data;
    if (
      !event.eventType.startsWith('recall.') &&
      !event.eventType.startsWith('serialization.')
    )
      return;
    // Fresh tokens on every delivery are safe for duplicates and out-of-order replay.
    await this.invalidateOrganization(event.organizationId);
    this.logger.log({
      message: 'Verification cache invalidated',
      organizationId: event.organizationId,
      eventType: event.eventType,
    });
  }
  async limit(org: string, user: string) {
    try {
      const key = createHash('sha256')
        .update(JSON.stringify([org, user]))
        .digest('hex');
      const result = await this.redis.window(
        `verification:rate:v1:${key}`,
        this.settings.VERIFICATION_RATE_WINDOW_SECONDS,
      );
      const allowed = result.count <= this.settings.VERIFICATION_RATE_LIMIT;
      this.logger.log({
        message: 'Verification rate limit',
        organizationId: org,
        allowed,
      });
      return { allowed, retryAfter: result.retryAfter };
    } catch {
      this.degraded(org);
      return { allowed: true, retryAfter: 0 };
    }
  }
  degraded(org: string) {
    this.logger.warn({
      message: 'Verification Redis unavailable; using authoritative reads',
      organizationId: org,
      redisDegraded: true,
    });
  }
}
