const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  VerificationProjection,
  projectionKey,
} = require('../services/recall-service/dist/verification-projection');
const {
  VerificationService,
} = require('../services/recall-service/dist/verification.service');
const { validateDynamoEnvironment } = require('../packages/config/dist');
const { DynamoStore } = require('../packages/dynamodb/dist');
const {
  ConfigService,
} = require('../services/recall-service/node_modules/@nestjs/config');
function fixture() {
  const identity = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    role: 'ORG_ADMIN',
  };
  const input = { gtin: '00012345600012', serialNumber: 'PACK-15' };
  const productId = randomUUID(),
    gtinId = randomUUID(),
    batchId = randomUUID();
  const serial = {
    id: randomUUID(),
    organizationId: identity.organizationId,
    productId,
    gtinId,
    batchId,
    serialNumber: input.serialNumber,
    status: 'COMMISSIONED',
  };
  const gtin = {
    id: gtinId,
    organizationId: identity.organizationId,
    productId,
    gtin: input.gtin,
    status: 'ACTIVE',
    product: {
      id: productId,
      organizationId: identity.organizationId,
      name: 'Medicine',
      status: 'ACTIVE',
    },
  };
  const batch = {
    id: batchId,
    productId,
    gtinId,
    organizationId: identity.organizationId,
    lotNumber: 'LOT15',
    expiryDate: '2099-01-01',
    status: 'ACTIVE',
  };
  const values = new Map();
  const store = {
    settings: { VERIFICATION_PROJECTION_ENABLED: true },
    fail: false,
    async get(key) {
      if (this.fail) throw new Error('DynamoDB down');
      return values.get(JSON.stringify(key));
    },
    async put(item, conditional) {
      if (this.fail) throw new Error('DynamoDB down');
      const key = JSON.stringify({ PK: item.PK, SK: item.SK });
      const old = values.get(key);
      if (conditional && old && old.revision >= item.revision) return false;
      values.set(key, globalThis.structuredClone(item));
      return true;
    },
  };
  let reads = 0,
    recall = null,
    failRefs = false;
  const refs = {
    async get(service, path) {
      reads++;
      if (failRefs) throw new Error('Owner down');
      if (path.includes('projection-page'))
        return {
          organizationId: identity.organizationId,
          items: path.includes('?after=') ? [] : [serial],
        };
      return service === 'PRODUCT'
        ? gtin
        : service === 'BATCH'
          ? batch
          : serial;
    },
  };
  const projection = new VerificationProjection(store, refs);
  let cached,
    cacheWrites = 0;
  const cache = {
    async key() {
      return 'key';
    },
    async read() {
      return cached;
    },
    async write(k, v) {
      cached = v;
      cacheWrites++;
    },
    degraded() {},
  };
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
  const event = (type) => ({
    eventId: randomUUID(),
    eventType: type,
    organizationId: identity.organizationId,
    aggregateId: serial.id,
    occurredAt: new Date().toISOString(),
  });
  return {
    identity,
    input,
    serial,
    gtin,
    batch,
    values,
    store,
    refs,
    projection,
    service,
    cache,
    event,
    get reads() {
      return reads;
    },
    get writes() {
      return cacheWrites;
    },
    clearCache() {
      cached = undefined;
    },
    setRecall(v) {
      recall = v;
    },
    failOwners() {
      failRefs = true;
    },
  };
}
test('Phase15 key normalizes identity and isolates organizations', () => {
  const f = fixture();
  assert.deepEqual(
    projectionKey(f.identity.organizationId, ' 00012345600012 ', ' PACK-15 '),
    projectionKey(
      f.identity.organizationId,
      f.input.gtin,
      f.input.serialNumber,
    ),
  );
  assert.notDeepEqual(
    projectionKey(randomUUID(), f.input.gtin, f.input.serialNumber),
    projectionKey(
      f.identity.organizationId,
      f.input.gtin,
      f.input.serialNumber,
    ),
  );
  assert.throws(() => projectionKey('org', 'bad', 'serial'));
});
test('Phase15 invalid table, region, endpoint and timeout rejected', () => {
  for (const cfg of [
    { DYNAMODB_TABLE: 'x' },
    { AWS_REGION: 'bad' },
    { DYNAMODB_ENDPOINT: 'file:///tmp/db' },
    { DYNAMODB_ENDPOINT: 'http://user:pass@localhost' },
    { DYNAMODB_TIMEOUT_MS: 0 },
    { VERIFICATION_PROJECTION_ENABLED: 'yes' },
  ])
    assert.throws(() => validateDynamoEnvironment(cfg));
  assert.equal(
    validateDynamoEnvironment({}).VERIFICATION_PROJECTION_ENABLED,
    false,
  );
});
test('Phase15 authoritative miss creates projection, DynamoDB hit avoids owners and populates Redis; Redis hit avoids DynamoDB', async () => {
  const f = fixture();
  assert.equal((await f.service.verify(f.identity, f.input)).result, 'VALID');
  assert.equal(f.values.size, 1);
  f.clearCache();
  const reads = f.reads;
  assert.equal((await f.service.verify(f.identity, f.input)).result, 'VALID');
  assert.equal(f.reads, reads);
  assert.equal(f.writes, 2);
  f.store.fail = true;
  f.failOwners();
  assert.equal((await f.service.verify(f.identity, f.input)).result, 'VALID');
});
test('Phase15 DynamoDB outage falls back safely; both unavailable never produce VALID', async () => {
  const f = fixture();
  f.store.fail = true;
  assert.equal((await f.service.verify(f.identity, f.input)).result, 'VALID');
  f.clearCache();
  f.failOwners();
  await assert.rejects(f.service.verify(f.identity, f.input), /Owner down/);
});
test('Phase15 malformed, stale, expired and cross-organization projections rejected', async () => {
  const f = fixture();
  await f.service.verify(f.identity, f.input);
  const key = JSON.stringify(
    projectionKey(
      f.identity.organizationId,
      f.input.gtin,
      f.input.serialNumber,
    ),
  );
  const good = globalThis.structuredClone(f.values.get(key));
  for (const patch of [
    { organizationId: randomUUID() },
    { response: {} },
    { revision: Date.now() - 31000 },
    { serializationStatus: 'DECOMMISSIONED' },
    { generation: 'wrong' },
  ]) {
    f.values.set(key, { ...good, ...patch });
    assert.equal(
      await f.projection.read(f.identity, f.input.gtin, f.input.serialNumber),
      undefined,
    );
  }
  f.values.set(key, good);
  assert.equal(
    await f.projection.read(
      { ...f.identity, organizationId: randomUUID() },
      f.input.gtin,
      f.input.serialNumber,
    ),
    undefined,
  );
});
for (const [status, result] of [
  ['COMMISSIONED', 'VALID'],
  ['QUARANTINED', 'QUARANTINED'],
  ['DECOMMISSIONED', 'DECOMMISSIONED'],
])
  test(`Phase15 serialization ${status} projects ${result}`, async () => {
    const f = fixture();
    f.serial.status = status;
    await f.projection.consume(
      f.event(`serialization.${status.toLowerCase()}`),
      (who, input, event) => f.service.authoritative(who, input, event),
    );
    assert.equal(
      (await f.projection.read(f.identity, f.input.gtin, f.input.serialNumber))
        .result,
      result,
    );
  });
for (const close of ['closed', 'cancelled'])
  test(`Phase15 recall activation and ${close} use current owner state, including old replay`, async () => {
    const f = fixture();
    f.setRecall({
      id: randomUUID(),
      recallNumber: 'R15',
      title: 'Recall',
      reason: 'Safety',
      severity: 'CLASS_I',
    });
    const refresh = (who, input, event) =>
      f.service.authoritative(who, input, event);
    const activated = f.event('recall.activated');
    await f.projection.consume(activated, refresh);
    assert.equal(
      (await f.projection.read(f.identity, f.input.gtin, f.input.serialNumber))
        .result,
      'RECALLED',
    );
    f.setRecall(null);
    await f.projection.consume(f.event(`recall.${close}`), refresh);
    await f.projection.consume(activated, refresh);
    const snapshot = await f.projection.read(
      f.identity,
      f.input.gtin,
      f.input.serialNumber,
    );
    // Equal-millisecond refreshes may conservatively miss, but never restore RECALLED.
    if (snapshot) assert.equal(snapshot.result, 'VALID');
    assert.equal((await f.service.verify(f.identity, f.input)).result, 'VALID');
  });
test('Phase15 conditional writes reject duplicate and older snapshots', async () => {
  const f = fixture();
  await f.service.verify(f.identity, f.input);
  const key = JSON.stringify(
    projectionKey(
      f.identity.organizationId,
      f.input.gtin,
      f.input.serialNumber,
    ),
  );
  const p = f.values.get(key);
  assert.equal(
    await f.store.put({ ...p, revision: p.revision - 1 }, true),
    false,
  );
  assert.equal(await f.store.put(p, true), false);
  assert.deepEqual(f.values.get(key), p);
});
test('Phase15 rebuild repeatable and bounded with validated page budget', async () => {
  const f = fixture();
  const refresh = (input) =>
    f.service.authoritative(f.identity, input, undefined, true);
  await f.projection.rebuild(f.identity, refresh);
  await f.projection.rebuild(f.identity, refresh);
  assert.equal(f.values.size, 1);
  await assert.rejects(
    f.projection.rebuild(f.identity, refresh, undefined, 101),
  );
  let pages = 0,
    count = 0;
  f.refs.get = async (service) =>
    service === 'PRODUCT'
      ? f.gtin
      : {
          organizationId: f.identity.organizationId,
          items: Array.from({ length: 50 }, () => ({
            ...f.serial,
            id: randomUUID(),
          })),
        };
  const cursor = await f.projection.rebuild(
    f.identity,
    async () => {
      count++;
    },
    undefined,
    2,
  );
  pages = count / 50;
  assert.equal(pages, 2);
  assert.ok(cursor);
});
test('Phase15 AWS SDK commands request consistent reads and conditional writes', async () => {
  const store = new DynamoStore(new ConfigService({}));
  const calls = [];
  store.client.send = async (command) => {
    calls.push(command.input);
    return { Item: { PK: 'p', SK: 's' } };
  };
  assert.deepEqual(await store.get({ PK: 'p', SK: 's' }), { PK: 'p', SK: 's' });
  await store.put({ PK: 'p', SK: 's', revision: 2 }, true);
  assert.equal(calls[0].ConsistentRead, true);
  assert.match(calls[1].ConditionExpression, /revision </);
  store.client.send = async () => {
    const e = new Error();
    e.name = 'ConditionalCheckFailedException';
    throw e;
  };
  assert.equal(await store.put({ revision: 1 }, true), false);
  store.onModuleDestroy();
});

test('Phase15 stale expiry/catalog eligibility is refreshed through the shared decision path', async () => {
  for (const mutate of [
    (f) => {
      f.batch.expiryDate = '2000-01-01';
    },
    (f) => {
      f.gtin.status = 'INACTIVE';
    },
    (f) => {
      f.gtin.product.status = 'INACTIVE';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(
      (await f.service.verify(f.identity, f.input)).result,
      'UNKNOWN',
    );
    f.clearCache();
    assert.equal(
      (await f.service.verify(f.identity, f.input)).result,
      'UNKNOWN',
    );
  }
  const f = fixture();
  await f.service.verify(f.identity, f.input);
  const key = JSON.stringify(
    projectionKey(
      f.identity.organizationId,
      f.input.gtin,
      f.input.serialNumber,
    ),
  );
  const item = f.values.get(key);
  item.expiryDate = '2000-01-01';
  item.response.expiryDate = item.expiryDate;
  assert.equal(
    await f.projection.read(f.identity, f.input.gtin, f.input.serialNumber),
    undefined,
  );
});
test('Phase15 Redis outage still allows a usable DynamoDB snapshot', async () => {
  const f = fixture();
  await f.service.verify(f.identity, f.input);
  f.clearCache();
  f.cache.key = async () => {
    throw new Error('Redis down');
  };
  f.failOwners();
  assert.equal((await f.service.verify(f.identity, f.input)).result, 'VALID');
});
test('Phase15 old commission replay cannot regress current decommissioned state', async () => {
  const f = fixture();
  const old = f.event('serialization.commissioned');
  old.occurredAt = '2000-01-01T00:00:00.000Z';
  f.serial.status = 'DECOMMISSIONED';
  const refresh = (who, input, event) =>
    f.service.authoritative(who, input, event);
  await f.projection.consume(f.event('serialization.decommissioned'), refresh);
  await f.projection.consume(old, refresh);
  await f.projection.consume(old, refresh);
  const snapshot = await f.projection.read(
    f.identity,
    f.input.gtin,
    f.input.serialNumber,
  );
  if (snapshot) assert.equal(snapshot.result, 'DECOMMISSIONED');
  assert.equal(
    (await f.service.verify(f.identity, f.input)).result,
    'DECOMMISSIONED',
  );
});
test('Phase15 failed consumer projection write remains retryable and rebuild rejects failed repairs', async () => {
  const f = fixture();
  f.store.fail = true;
  await assert.rejects(
    f.projection.consume(f.event('recall.activated'), (who, input, event) =>
      f.service.authoritative(who, input, event),
    ),
  );
  await assert.rejects(
    f.projection.rebuild(f.identity, (input) =>
      f.service.authoritative(f.identity, input, undefined, true),
    ),
  );
});
test('Phase15 generation fencing rejects in-flight old refresh snapshots', async () => {
  const f = fixture();
  await f.service.verify(f.identity, f.input);
  await f.store.put({
    PK: `ORG#${f.identity.organizationId}`,
    SK: 'GENERATION',
    generation: 'new',
  });
  assert.equal(
    await f.projection.read(f.identity, f.input.gtin, f.input.serialNumber),
    undefined,
  );
});

test('Phase15 consumer updates DynamoDB despite Redis outage and retains retry on failed invalidation', async () => {
  const {
    VerificationInvalidationConsumer,
  } = require('../services/recall-service/dist/verification-consumer');
  const f = fixture();
  let invalidations = 0;
  const cache = {
    async invalidate() {
      invalidations++;
      throw new Error('Redis down');
    },
  };
  const consumer = new VerificationInvalidationConsumer(
    {},
    cache,
    f.projection,
    f.service,
  );
  await assert.rejects(
    consumer.handle(f.event('serialization.commissioned')),
    /Redis down/,
  );
  assert.equal(invalidations, 2);
  assert.equal(
    (await f.projection.read(f.identity, f.input.gtin, f.input.serialNumber))
      .result,
    'VALID',
  );
});
