import { Injectable, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { validateRedisEnvironment } from '@pharma/config';

/** Small bounded command surface; callers never receive the underlying connection. */
@Injectable()
export class RedisStore {
  private readonly client: Redis;
  private readonly logger = new Logger('Redis');
  constructor(config: ConfigService) {
    const s = validateRedisEnvironment(
      Object.fromEntries(
        [
          'REDIS_URL',
          'REDIS_CONNECT_TIMEOUT_MS',
          'REDIS_COMMAND_TIMEOUT_MS',
        ].map((k) => [k, config.get(k)]),
      ),
    );
    this.client = new Redis(s.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: s.REDIS_CONNECT_TIMEOUT_MS,
      commandTimeout: s.REDIS_COMMAND_TIMEOUT_MS,
      retryStrategy: (times) => Math.min(times * 250, 3000),
    });
    this.client.on('error', () =>
      this.logger.warn({ message: 'Redis degraded', redisDegraded: true }),
    );
  }
  async onModuleInit() {
    try {
      await this.client.connect();
    } catch {
      /* optional dependency */
    }
  }
  onModuleDestroy() {
    this.client.disconnect();
  }
  get(key: string) {
    return this.client.get(key);
  }
  async set(key: string, value: string, ttl: number) {
    await this.client.set(key, value, 'EX', ttl);
  }
  async del(key: string) {
    await this.client.del(key);
  }
  increment(key: string) {
    return this.client.incr(key);
  }
  async expire(key: string, seconds: number) {
    await this.client.expire(key, seconds);
  }
  /** Atomic initialization prevents generation resurrection after eviction/restart. */
  async generation(key: string, candidate: string): Promise<string> {
    return String(
      await this.client.eval(
        "local v=redis.call('GET',KEYS[1]); if v then return v end; redis.call('SET',KEYS[1],ARGV[1]); return ARGV[1]",
        1,
        key,
        candidate,
      ),
    );
  }
  async rotate(key: string, token: string) {
    await this.client.set(key, token);
  }
  /** Atomic counter + expiry: a failed process cannot leave a permanent limit. */
  async window(
    key: string,
    seconds: number,
  ): Promise<{ count: number; retryAfter: number }> {
    const result = (await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('TTL',KEYS[1])}",
      1,
      key,
      seconds,
    )) as number[];
    return { count: result[0]!, retryAfter: Math.max(1, result[1]!) };
  }
  async health() {
    try {
      return (await this.client.ping()) === 'PONG' ? 'ok' : 'degraded';
    } catch {
      return 'degraded';
    }
  }
}
@Module({ providers: [RedisStore], exports: [RedisStore] })
export class RedisModule {}
