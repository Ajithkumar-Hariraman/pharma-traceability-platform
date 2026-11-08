const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  ConfigService,
} = require('../services/recall-service/node_modules/@nestjs/config');
const {
  NotFoundException,
  ServiceUnavailableException,
} = require('../services/recall-service/node_modules/@nestjs/common');
const {
  VerificationService,
} = require('../services/recall-service/dist/verification.service');
const {
  VerificationCache,
} = require('../services/recall-service/dist/verification-cache');
const { validateRedisEnvironment } = require('../packages/config/dist');
class MemoryRedis {
  values = new Map();
  ttl = new Map();
  calls = [];
  fail = false;
  writeFail = false;
  check() {
    if (this.fail) throw new Error('offline');
  }
  async get(k) {
    this.check();
    return this.values.get(k) ?? null;
  }
  async set(k, v, ttl) {
    this.check();
    if (this.writeFail) throw new Error('write failed');
    this.values.set(k, v);
    this.ttl.set(k, ttl);
  }
  async del(k) {
    this.check();
    this.values.delete(k);
  }
  async generation(k, v) {
    this.check();
    if (!this.values.has(k)) this.values.set(k, v);
    return this.values.get(k);
  }
  async rotate(k, v) {
    this.check();
    this.values.set(k, v);
  }
  async window(k, seconds) {
    this.check();
    this.calls.push(k);
    const n = (this.values.get(k) ?? 0) + 1;
    this.values.set(k, n);
    return { count: n, retryAfter: seconds };
  }
}
function fixture(settings = {}) {
  const redis = new MemoryRedis();
  const cache = new VerificationCache(redis, new ConfigService(settings));
  const who = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    role: 'OPERATOR',
  };
  const productId = randomUUID(),
    gtinId = randomUUID(),
    batchId = randomUUID(),
    itemId = randomUUID();
  const input = { gtin: '00012345600012', serialNumber: 'PACK-14' };
  const product = {
    id: productId,
    organizationId: who.organizationId,
    name: 'Medicine',
    status: 'ACTIVE',
  };
  const gtin = {
    id: gtinId,
    productId,
    organizationId: who.organizationId,
    gtin: input.gtin,
    status: 'ACTIVE',
    product,
  };
  const serial = {
    id: itemId,
    productId,
    gtinId,
    batchId,
    serialNumber: input.serialNumber,
    status: 'COMMISSIONED',
  };
  const batch = {
    id: batchId,
    productId,
    gtinId,
    lotNumber: 'LOT',
    expiryDate: '2099-01-01',
    status: 'ACTIVE',
  };
  let recall = null,
    reads = 0,
    failure = null;
  const refs = {
    get: async (service) => {
      reads++;
      if (failure) throw failure;
      return service === 'PRODUCT'
        ? gtin
        : service === 'BATCH'
          ? batch
          : serial;
    },
  };
  const db = { recall: { findFirst: async () => recall } };
  const service = new VerificationService(db, refs, cache);
  const event = (type) => ({
    eventId: randomUUID(),
    eventType: type,
    eventVersion: 1,
    organizationId: who.organizationId,
    aggregateType: type.startsWith('recall.') ? 'recall' : 'serialized-item',
    aggregateId: type.startsWith('recall.') ? productId : itemId,
    producer: type.startsWith('recall.')
      ? 'recall-service'
      : 'serialization-service',
    occurredAt: new Date().toISOString(),
    payload: type.startsWith('recall.')
      ? {
          productId,
          metadata: {
            recallId: productId,
            recallNumber: 'R',
            title: 'Recall',
            reason: 'Reason',
            severity: 'CLASS_I',
          },
        }
      : { serializedItemId: itemId, productId, gtinId, batchId },
  });
  return {
    redis,
    cache,
    who,
    input,
    serial,
    service,
    event,
    verify: () => service.verify(who, input),
    reads: () => reads,
    setFailure: (v) => (failure = v),
    setRecall: (v) => (recall = v),
  };
}
test('Phase 14: cache miss populates VALID; hit returns identical validated result without references', async () => {
  const f = fixture();
  const a = await f.verify();
  assert.equal(a.result, 'VALID');
  assert.equal(f.reads(), 3);
  assert.deepEqual(await f.verify(), a);
  assert.equal(f.reads(), 3);
  assert.equal(
    f.redis.ttl.get(
      await f.cache.key(
        f.who.organizationId,
        f.input.gtin,
        f.input.serialNumber,
      ),
    ),
    30,
  );
});
test('Phase 14: configurable TTL and UNKNOWN uses shorter policy', async () => {
  const f = fixture({
    VERIFICATION_CACHE_TTL_SECONDS: 17,
    VERIFICATION_UNKNOWN_TTL_SECONDS: 2,
  });
  await f.verify();
  const k = await f.cache.key(
    f.who.organizationId,
    f.input.gtin,
    f.input.serialNumber,
  );
  assert.equal(f.redis.ttl.get(k), 17);
  await f.redis.del(k);
  f.setFailure(new NotFoundException());
  assert.equal((await f.verify()).result, 'UNKNOWN');
  assert.equal(f.redis.ttl.get(k), 2);
  const reads = f.reads();
  assert.equal((await f.verify()).result, 'UNKNOWN');
  assert.equal(f.reads(), reads);
});
for (const raw of [
  'not json',
  JSON.stringify({ result: 'VALID' }),
  JSON.stringify({
    result: 'VALID',
    gtin: 'other',
    serialNumber: 'other',
    verifiedAt: new Date().toISOString(),
    explanation: 'bad',
    productName: 'M',
    lotNumber: 'L',
  }),
])
  test(
    'Phase 14: malformed or mismatched cache data recomputes ' +
      raw.slice(0, 20),
    async () => {
      const f = fixture();
      const k = await f.cache.key(
        f.who.organizationId,
        f.input.gtin,
        f.input.serialNumber,
      );
      f.redis.values.set(k, raw);
      assert.equal((await f.verify()).result, 'VALID');
      assert.equal(f.reads(), 3);
    },
  );
test('Phase 14: Redis offline falls back; write failure preserves authoritative result', async () => {
  const f = fixture();
  f.redis.fail = true;
  assert.equal((await f.verify()).result, 'VALID');
  f.redis.fail = false;
  f.redis.writeFail = true;
  assert.equal((await f.verify()).result, 'VALID');
  assert.equal(f.reads(), 6);
});
test('Phase 14: downstream unavailability never caches VALID', async () => {
  const f = fixture();
  f.setFailure(new ServiceUnavailableException());
  await assert.rejects(f.verify(), (e) => e.getStatus() === 503);
  assert.equal(f.redis.ttl.size, 0);
  f.redis.fail = true;
  await assert.rejects(f.verify(), (e) => e.getStatus() === 503);
});
for (const [type, status] of [
  ['serialization.commissioned', 'COMMISSIONED'],
  ['serialization.quarantined', 'QUARANTINED'],
  ['serialization.decommissioned', 'DECOMMISSIONED'],
])
  test('Phase 14: ' + type + ' rotates cached identity', async () => {
    const f = fixture();
    f.serial.status = 'QUARANTINED';
    await f.verify();
    f.serial.status = status;
    await f.cache.invalidate(f.event(type));
    assert.equal(
      (await f.verify()).result,
      status === 'COMMISSIONED' ? 'VALID' : status,
    );
    assert.equal(f.reads(), 6);
  });
for (const type of ['recall.activated', 'recall.closed', 'recall.cancelled'])
  test(
    'Phase 14: ' + type + ' invalidates whole scope without scans',
    async () => {
      const f = fixture();
      await f.verify();
      f.setRecall({
        recallNumber: 'R',
        title: 'T',
        reason: 'R',
        severity: 'CLASS_I',
      });
      await f.cache.invalidate(f.event('recall.activated'));
      assert.equal((await f.verify()).result, 'RECALLED');
      if (type !== 'recall.activated') {
        f.setRecall(null);
        await f.cache.invalidate(f.event(type));
        assert.equal((await f.verify()).result, 'VALID');
      }
    },
  );
test('Phase 14: replay, malformed events, concurrent fills and lost generation are safe', async () => {
  const f = fixture();
  const old = await f.cache.key(
    f.who.organizationId,
    f.input.gtin,
    f.input.serialNumber,
  );
  const e = f.event('recall.activated');
  await f.cache.invalidate(e);
  const next = await f.cache.key(
    f.who.organizationId,
    f.input.gtin,
    f.input.serialNumber,
  );
  assert.notEqual(old, next);
  await f.cache.invalidate(e);
  assert.notEqual(
    next,
    await f.cache.key(f.who.organizationId, f.input.gtin, f.input.serialNumber),
  );
  await f.cache.invalidate({ bad: true });
  f.redis.values.delete(`verification:v1:${f.who.organizationId}:generation`);
  assert.notEqual(
    old,
    await f.cache.key(f.who.organizationId, f.input.gtin, f.input.serialNumber),
  );
});
test('Phase 14: invalidation failure rejects for Kafka retry', async () => {
  const f = fixture();
  f.redis.fail = true;
  await assert.rejects(f.cache.invalidate(f.event('recall.activated')));
});
test('Phase 14: limiter counts hits; identities isolated; fails open', async () => {
  const f = fixture({
    VERIFICATION_RATE_LIMIT: 2,
    VERIFICATION_RATE_WINDOW_SECONDS: 11,
  });
  assert.equal(
    (await f.cache.limit(f.who.organizationId, f.who.userId)).allowed,
    true,
  );
  assert.equal(
    (await f.cache.limit(f.who.organizationId, f.who.userId)).allowed,
    true,
  );
  assert.deepEqual(await f.cache.limit(f.who.organizationId, f.who.userId), {
    allowed: false,
    retryAfter: 11,
  });
  assert.equal(
    (await f.cache.limit(f.who.organizationId, randomUUID())).allowed,
    true,
  );
  assert.equal((await f.cache.limit(randomUUID(), f.who.userId)).allowed, true);
  f.redis.fail = true;
  assert.equal(
    (await f.cache.limit(f.who.organizationId, f.who.userId)).allowed,
    true,
  );
});
test('Phase 14: bounded config rejects invalid settings without leaking credentials', () => {
  for (const [key, value] of Object.entries({
    REDIS_URL: 'https://secret:password@example.com',
    VERIFICATION_CACHE_TTL_SECONDS: 301,
    VERIFICATION_RATE_LIMIT: 0,
    VERIFICATION_RATE_WINDOW_SECONDS: 'abc',
    REDIS_COMMAND_TIMEOUT_MS: 10001,
  }))
    assert.throws(
      () => validateRedisEnvironment({ [key]: value }),
      new RegExp('Invalid ' + key),
    );
  assert.equal(
    validateRedisEnvironment({ REDIS_URL: 'rediss://localhost:6380' })
      .REDIS_URL,
    'rediss://localhost:6380',
  );
});

test('Phase 14: route emits 429 and Retry-After; limiter never wraps other routes', async () => {
  const {
    RecallController,
  } = require('../services/recall-service/dist/recall.controller');
  let calls = 0;
  const controller = new RecallController(
    {},
    {
      verify: async () => {
        calls++;
        return { result: 'VALID' };
      },
    },
    { limit: async () => ({ allowed: false, retryAfter: 7 }) },
  );
  const headers = {};
  await assert.rejects(
    controller.verify(
      randomUUID(),
      {},
      { userId: randomUUID() },
      { setHeader: (k, v) => (headers[k] = v) },
    ),
    (e) => e.getStatus() === 429,
  );
  assert.equal(headers['Retry-After'], '7');
  assert.equal(calls, 0);
});
test('Phase 14: actual Redis atomic windows, TTL, generations, lifecycle and health', async () => {
  const { RedisStore } = require('../packages/redis/dist');
  const redis = new RedisStore(
    new ConfigService({
      REDIS_URL: process.env.PHASE14_REDIS_URL ?? 'redis://127.0.0.1:6379',
    }),
  );
  await redis.onModuleInit();
  const prefix = `phase14-test:${randomUUID()}`;
  try {
    assert.equal(await redis.health(), 'ok');
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () =>
        redis.generation(`${prefix}:generation`, randomUUID()),
      ),
    );
    assert.equal(new Set(tokens).size, 1);
    await redis.rotate(`${prefix}:generation`, 'new');
    assert.equal(
      await redis.generation(`${prefix}:generation`, 'ignored'),
      'new',
    );
    await redis.set(`${prefix}:cache`, 'value', 1);
    assert.equal(await redis.get(`${prefix}:cache`), 'value');
    const counts = await Promise.all(
      Array.from({ length: 10 }, () => redis.window(`${prefix}:window`, 1)),
    );
    assert.deepEqual(
      counts.map((v) => v.count).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await redis.get(`${prefix}:cache`), null);
    assert.equal((await redis.window(`${prefix}:window`, 1)).count, 1);
  } finally {
    try {
      for (const suffix of ['generation', 'cache', 'window'])
        await redis.del(`${prefix}:${suffix}`);
    } finally {
      redis.onModuleDestroy();
    }
  }
  assert.equal(await redis.health(), 'degraded');
});
test('Phase 14: cache is isolated by organization and stale timestamps are rejected', async () => {
  const f = fixture();
  const result = await f.verify();
  const k = await f.cache.key(
    f.who.organizationId,
    f.input.gtin,
    f.input.serialNumber,
  );
  assert.notEqual(
    k,
    await f.cache.key(randomUUID(), f.input.gtin, f.input.serialNumber),
  );
  f.redis.values.set(
    k,
    JSON.stringify({ ...result, verifiedAt: '2000-01-01T00:00:00.000Z' }),
  );
  await f.verify();
  assert.equal(f.reads(), 6);
});

test('Phase 14: in-flight fill after invalidation remains unreachable', async () => {
  const f = fixture();
  const result = await f.verify();
  const old = await f.cache.key(
    f.who.organizationId,
    f.input.gtin,
    f.input.serialNumber,
  );
  await f.cache.invalidate(f.event('serialization.quarantined'));
  await f.cache.write(old, result);
  f.serial.status = 'QUARANTINED';
  assert.equal((await f.verify()).result, 'QUARANTINED');
});
test('Phase 14: readiness reports optional Redis and consumer degradation without failing business readiness', async () => {
  const {
    HealthController,
  } = require('../services/recall-service/dist/health.controller');
  const health = new HealthController(
    { $queryRaw: async () => {} },
    {
      enabled: false,
      consumerStatus: () => ({ enabled: true, running: false }),
    },
    { health: async () => 'degraded' },
  );
  const result = await health.ready();
  assert.equal(result.status, 'ok');
  assert.equal(result.redis, 'degraded');
  assert.equal(result.invalidation.running, false);
});
test('Phase 14: Gateway preserves 429 and Retry-After', async (t) => {
  const {
    RecallProxy,
  } = require('../apps/api-gateway/dist/recalls/recall-proxy');
  const org = randomUUID(),
    user = randomUUID();
  const previous = globalThis.fetch;
  t.after(() => (globalThis.fetch = previous));
  globalThis.fetch = async () =>
    new globalThis.Response('{}', {
      status: 429,
      headers: { 'Retry-After': '13' },
    });
  const proxy = new RecallProxy(
    new ConfigService({
      RECALL_SERVICE_URL: 'http://localhost:3009',
      INTERNAL_IDENTITY_SECRET: 'test-secret',
    }),
    {
      forward: async () => ({
        organizationId: org,
        userId: user,
        role: 'VIEWER',
      }),
    },
  );
  const headers = {};
  await assert.rejects(
    proxy.forward(
      'POST',
      `/organizations/${org}/verification`,
      user,
      {},
      { setHeader: (k, v) => (headers[k] = v) },
    ),
    (e) => e.getStatus() === 429,
  );
  assert.equal(headers['Retry-After'], '13');
});

test('Phase 14: consumer group joining does not block business startup', async () => {
  const {
    VerificationInvalidationConsumer,
  } = require('../services/recall-service/dist/verification-cache');
  let finish;
  let called = false;
  const consumer = new VerificationInvalidationConsumer(
    {
      consume: async () => {
        called = true;
        await new Promise((resolve) => (finish = resolve));
      },
    },
    { invalidate: async () => {} },
  );
  assert.equal(consumer.onApplicationBootstrap(), undefined);
  assert.equal(called, true);
  consumer.onModuleDestroy();
  finish();
});
