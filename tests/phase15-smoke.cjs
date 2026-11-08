// Infrastructure smoke: real Kafka, DynamoDB Local and Redis; deterministic owner fixtures.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  ConfigService,
} = require('../services/recall-service/node_modules/@nestjs/config');
const { DynamoStore } = require('../packages/dynamodb/dist');
const { RedisStore } = require('../packages/redis/dist');
const { Messaging } = require('../packages/messaging/dist');
const {
  VerificationProjection,
  projectionKey,
} = require('../services/recall-service/dist/verification-projection');
const {
  VerificationService,
} = require('../services/recall-service/dist/verification.service');
const {
  VerificationCache,
  VerificationInvalidationConsumer,
} = require('../services/recall-service/dist/verification-cache');
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Smoke timeout');
}
async function main() {
  const config = new ConfigService({
    VERIFICATION_PROJECTION_ENABLED: 'true',
    DYNAMODB_TABLE: process.env.DYNAMODB_TABLE || 'pharma-verification',
    AWS_REGION: process.env.AWS_REGION,
    DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
    DYNAMODB_TIMEOUT_MS: 1000,
    REDIS_URL: process.env.REDIS_URL,
    EVENT_TRANSPORT: 'kafka',
    KAFKA_BROKERS: process.env.KAFKA_BROKERS || 'localhost:9092',
  });
  const who = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    role: 'ORG_ADMIN',
  };
  const input = {
    gtin: '00012345600012',
    serialNumber: `SMOKE-${randomUUID()}`,
  };
  const productId = randomUUID(),
    gtinId = randomUUID(),
    batchId = randomUUID(),
    itemId = randomUUID(),
    recallId = randomUUID();
  const serial = {
    id: itemId,
    organizationId: who.organizationId,
    productId,
    gtinId,
    batchId,
    serialNumber: input.serialNumber,
    status: 'COMMISSIONED',
  };
  const gtin = {
    id: gtinId,
    organizationId: who.organizationId,
    productId,
    gtin: input.gtin,
    status: 'ACTIVE',
    product: {
      id: productId,
      organizationId: who.organizationId,
      name: 'Smoke medicine',
      status: 'ACTIVE',
    },
  };
  const batch = {
    id: batchId,
    organizationId: who.organizationId,
    productId,
    gtinId,
    lotNumber: 'SMOKE',
    expiryDate: '2099-01-01',
    status: 'ACTIVE',
  };
  let recall = null,
    reads = 0;
  const refs = {
    async get(service, path) {
      reads++;
      if (path.includes('projection-page'))
        return { organizationId: who.organizationId, items: [serial] };
      return service === 'PRODUCT'
        ? gtin
        : service === 'BATCH'
          ? batch
          : serial;
    },
  };
  const store = new DynamoStore(config),
    redis = new RedisStore(config),
    messaging = new Messaging(config, true);
  const projection = new VerificationProjection(store, refs),
    cache = new VerificationCache(redis, config);
  const service = new VerificationService(
    {
      recall: {
        async findFirst() {
          return recall;
        },
      },
    },
    refs,
    cache,
    projection,
  );
  const consumer = new VerificationInvalidationConsumer(
    messaging,
    cache,
    projection,
    service,
  );
  const completed = new Set();
  try {
    await redis.onModuleInit();
    await messaging.onModuleInit();
    // Unique smoke group avoids changing the application's committed offsets.
    await messaging.consume(async (event) => {
      if (event.organizationId !== who.organizationId) return;
      await consumer.handle(event);
      completed.add(event.eventId);
    }, `phase15-smoke-${randomUUID()}`);
    const event = (type) => ({
      eventId: randomUUID(),
      eventType: type,
      eventVersion: 1,
      organizationId: who.organizationId,
      aggregateType: type.startsWith('recall.') ? 'recall' : 'serialized-item',
      aggregateId: type.startsWith('recall.') ? recallId : itemId,
      occurredAt: new Date().toISOString(),
      producer: type.startsWith('recall.')
        ? 'recall-service'
        : 'serialization-service',
      payload: type.startsWith('recall.')
        ? {
            productId,
            batchId,
            metadata: {
              recallId,
              recallNumber: 'SMOKE-R',
              title: 'Smoke recall',
              reason: 'Smoke safety',
              severity: 'CLASS_I',
            },
          }
        : { serializedItemId: itemId, productId, gtinId, batchId },
    });
    const commissioned = event('serialization.commissioned');
    await messaging.publish(commissioned);
    await until(() => completed.has(commissioned.eventId));
    assert.equal(
      (
        await store.get(
          projectionKey(who.organizationId, input.gtin, input.serialNumber),
        )
      ).verificationStatus,
      'VALID',
    );
    let before = reads;
    assert.equal((await service.verify(who, input)).result, 'VALID');
    assert.equal(reads, before);
    const key = await cache.key(
      who.organizationId,
      input.gtin,
      input.serialNumber,
    );
    assert.equal(
      (await cache.read(key, input.gtin, input.serialNumber)).result,
      'VALID',
    );
    recall = {
      id: recallId,
      recallNumber: 'SMOKE-R',
      title: 'Smoke recall',
      reason: 'Smoke safety',
      severity: 'CLASS_I',
    };
    const activated = event('recall.activated');
    await messaging.publish(activated);
    await until(() => completed.has(activated.eventId));
    assert.equal(
      await cache.read(
        await cache.key(who.organizationId, input.gtin, input.serialNumber),
        input.gtin,
        input.serialNumber,
      ),
      undefined,
    );
    before = reads;
    assert.equal((await service.verify(who, input)).result, 'RECALLED');
    assert.equal(reads, before);
    // Real conditional write rejects historical snapshot regression.
    const item = await store.get(
      projectionKey(who.organizationId, input.gtin, input.serialNumber),
    );
    assert.equal(
      await store.put({ ...item, revision: item.revision - 1 }, true),
      false,
    );
    await cache.invalidateOrganization(who.organizationId);
    const offline = new DynamoStore(
      new ConfigService({
        VERIFICATION_PROJECTION_ENABLED: 'true',
        DYNAMODB_ENDPOINT: 'http://127.0.0.1:1',
        AWS_REGION: process.env.AWS_REGION,
        DYNAMODB_TIMEOUT_MS: 100,
      }),
    );
    try {
      const degraded = new VerificationService(
        {
          recall: {
            async findFirst() {
              return recall;
            },
          },
        },
        refs,
        cache,
        new VerificationProjection(offline, refs),
      );
      before = reads;
      assert.equal((await degraded.verify(who, input)).result, 'RECALLED');
      assert.ok(reads > before);
    } finally {
      offline.onModuleDestroy();
    }
    globalThis.console.log(
      JSON.stringify({
        phase15Smoke: 'passed',
        kafka: true,
        dynamodb: true,
        redis: true,
        recallInvalidation: true,
        outageFallback: true,
        ownerFixtures: true,
      }),
    );
  } finally {
    consumer.onModuleDestroy();
    await messaging.onModuleDestroy();
    redis.onModuleDestroy();
    store.onModuleDestroy();
  }
}
void main().catch((error) => {
  globalThis.console.error(error);
  process.exitCode = 1;
});
