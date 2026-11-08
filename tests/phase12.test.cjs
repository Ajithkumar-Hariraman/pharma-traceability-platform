const { test } = require('node:test');
const { URL } = require('node:url');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { parseEnv } = require('node:util');
const {
  ConfigService,
} = require('../packages/messaging/node_modules/@nestjs/config');
const { validateOutboxEnvironment } = require('../packages/config/dist');
const {
  Messaging,
  enqueueEvent,
  fromTrace,
  toTrace,
  PostgresOutboxStore,
  OutboxPublisher,
} = require('../packages/messaging/dist');
const {
  SerializationRepository,
} = require('../services/serialization-service/dist/serialization.repository');
const {
  SerializationService,
} = require('../services/serialization-service/dist/serialization.service');
const {
  TraceCaptureClient: SerialCapture,
} = require('../services/serialization-service/dist/trace-capture.client');
const {
  TraceCaptureClient: ShipmentCapture,
} = require('../services/shipment-service/dist/trace-capture.client');
const {
  AggregationService,
} = require('../services/aggregation-service/dist/aggregation.service');
const {
  ShipmentService,
} = require('../services/shipment-service/dist/shipment.service');
const {
  TraceService,
} = require('../services/traceability-service/dist/trace.service');
const {
  TraceConsumer,
} = require('../services/traceability-service/dist/trace-consumer');
const env = (name) =>
  parseEnv(readFileSync(`services/${name}-service/.env`, 'utf8'));
const DB = (name) =>
  require(`../services/${name}-service/dist/persistence/prisma.service`)
    .PrismaService;
const config = (overrides) =>
  validateOutboxEnvironment({
    OUTBOX_RETRY_BASE_MS: 100,
    OUTBOX_RETRY_MAX_MS: 1000,
    ...overrides,
  });
const unavailable = {
  enabled: true,
  publish: async () => {
    throw new Error('Kafka unavailable; secret=do-not-store');
  },
};
function event(org = randomUUID()) {
  return fromTrace({
    organizationId: org,
    eventId: randomUUID(),
    eventType: 'OBJECT',
    action: 'ADD',
    businessStep: 'commissioning',
    eventTime: new Date().toISOString(),
    serializedItemId: randomUUID(),
    batchId: randomUUID(),
    productId: randomUUID(),
    gtinId: randomUUID(),
  });
}
async function isolated(name, t) {
  // Publisher tests must never claim unrelated local application events.
  const owner = new (DB(name))(new ConfigService(env(name)));
  await owner.$connect();
  const schema = `p12_${randomUUID().replaceAll('-', '')}`;
  await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(env(name).DATABASE_URL);
  url.searchParams.set('schema', schema);
  const db = new (DB(name))(
    new ConfigService({ ...env(name), DATABASE_URL: url.toString() }),
  );
  t.after(async () => {
    await db.$disconnect();
    await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.$disconnect();
  });
  const base = `services/${name}-service/prisma/migrations`;
  for (const folder of readdirSync(base)
    .filter((v) => /^\d/.test(v))
    .sort()) {
    for (const sql of readFileSync(`${base}/${folder}/migration.sql`, 'utf8')
      .split(';')
      .filter((v) => v.replace(/--[^\n]*/g, '').trim()))
      await db.$executeRawUnsafe(sql);
  }
  return db;
}
async function traceDB(t) {
  const db = new (DB('traceability'))(new ConfigService(env('traceability')));
  await db.$connect();
  t.after(() => db.$disconnect());
  return db;
}
async function seedSerial(db, org = randomUUID()) {
  return db.serializedItem.create({
    data: {
      organizationId: org,
      batchId: randomUUID(),
      productId: randomUUID(),
      gtinId: randomUUID(),
      serialNumber: randomUUID(),
    },
  });
}
function serialService(db, row, kafka = unavailable) {
  return new SerializationService(
    new SerializationRepository(db),
    {
      validate: async () => ({
        status: 'ACTIVE',
        productId: row.productId,
        gtinId: row.gtinId,
      }),
    },
    new SerialCapture(new ConfigService(), kafka),
  );
}
const commission = (service, row) =>
  service.command(
    row.organizationId,
    row.id,
    'commission',
    {},
    randomUUID(),
    'ORG_ADMIN',
  );
const publisher = (
  db,
  messaging,
  settings = config(),
  store = new PostgresOutboxStore(db),
) => new OutboxPublisher(store, messaging, settings, 'serialization-service');
const pending = (db, e = event()) =>
  db.$transaction((tx) => enqueueEvent(tx, e)).then(() => e);

test('Phase 12 configuration validates bounded numeric settings and backoff relationships', () => {
  assert.equal(config().OUTBOX_RETENTION_DAYS, 7);
  for (const key of Object.keys(config())) {
    for (const value of [0, -1, 'NaN', '1.5', 999999999, true, ''])
      assert.throws(() => config({ [key]: value }), key);
  }
  assert.throws(() =>
    config({ OUTBOX_RETRY_BASE_MS: 2000, OUTBOX_RETRY_MAX_MS: 1000 }),
  );
  assert.equal(config({ OUTBOX_BATCH_SIZE: '5' }).OUTBOX_BATCH_SIZE, 5);
});

test('Phase 12 Serialization commits all three lifecycle events to its outbox without calling Kafka', async (t) => {
  const db = await isolated('serialization', t);
  let directCalls = 0;
  const kafka = {
    enabled: true,
    publish: async () => {
      directCalls++;
      throw new Error('offline');
    },
  };
  const row = await seedSerial(db);
  const service = serialService(db, row, kafka);
  await commission(service, row);
  await service.command(
    row.organizationId,
    row.id,
    'quarantine',
    {},
    randomUUID(),
    'ORG_ADMIN',
  );
  const second = await seedSerial(db);
  const other = serialService(db, second, kafka);
  await commission(other, second);
  await other.command(
    second.organizationId,
    second.id,
    'decommission',
    {},
    randomUUID(),
    'ORG_ADMIN',
  );
  const rows = await db.outboxEvent.findMany();
  assert.equal(rows.length, 4);
  assert.equal(directCalls, 0);
  assert.deepEqual(
    new Set(rows.map((r) => r.eventType)),
    new Set([
      'serialization.commissioned',
      'serialization.quarantined',
      'serialization.decommissioned',
    ]),
  );
  for (const r of rows) {
    assert.equal(r.status, 'PENDING');
    assert.equal(r.attempts, 0);
    assert.equal(r.eventId, r.envelope.eventId);
    assert.equal(r.organizationId, r.envelope.organizationId);
  }
  assert.equal(
    (await db.serializedItem.findUnique({ where: { id: second.id } })).status,
    'DECOMMISSIONED',
  );
});

test('Phase 12 Serialization rolls back state when outbox insertion fails and rolls back both after a later transaction failure', async (t) => {
  const db = await isolated('serialization', t);
  const row = await seedSerial(db);
  const failing = db.$extends({
    query: {
      outboxEvent: {
        create: async () => {
          throw new Error('insert failed');
        },
      },
    },
  });
  await assert.rejects(
    commission(serialService(failing, row), row),
    /insert failed/,
  );
  assert.equal(
    (await db.serializedItem.findUnique({ where: { id: row.id } })).status,
    'CREATED',
  );
  assert.equal(await db.outboxEvent.count(), 0);
  const repo = new SerializationRepository(db);
  const transition = repo.transition.bind(repo);
  repo.transition = (o, id, from, to, callback) =>
    transition(o, id, from, to, async (tx, updated) => {
      await callback(tx, updated);
      throw new Error('failure after both writes');
    });
  const service = serialService(db, row);
  service.repository = repo;
  await assert.rejects(commission(service, row), /failure after both writes/);
  assert.equal(
    (await db.serializedItem.findUnique({ where: { id: row.id } })).status,
    'CREATED',
  );
  assert.equal(await db.outboxEvent.count(), 0);
  await assert.rejects(
    db.$transaction(async (tx) => {
      await enqueueEvent(tx, event());
      throw new Error('business transaction failed');
    }),
  );
  assert.equal(await db.outboxEvent.count(), 0);
});

test('Phase 12 Aggregation atomically persists add/remove for items and containers, with rollback on insertion failure', async (t) => {
  const db = await isolated('aggregation', t),
    org = randomUUID(),
    user = randomUUID();
  const service = new AggregationService(
    db,
    { validate: async () => ({ status: 'COMMISSIONED' }) },
    unavailable,
  );
  const inner = await service.create(org, {
    containerCode: randomUUID(),
    packagingLevel: 'INNER',
  });
  const box = await service.create(org, {
    containerCode: randomUUID(),
    packagingLevel: 'CASE',
  });
  for (const [kind, child] of [
    ['items', randomUUID()],
    ['containers', inner.id],
  ]) {
    await service.change(org, box.id, kind, child, false, user, 'OPERATOR');
    const failing = db.$extends({
      query: {
        outboxEvent: {
          create: async () => {
            throw new Error('insert failed');
          },
        },
      },
    });
    await assert.rejects(
      new AggregationService(failing, {}, unavailable).change(
        org,
        box.id,
        kind,
        child,
        true,
        user,
        'OPERATOR',
      ),
      /insert failed/,
    );
    assert.equal(await db.aggregationRelation.count(), 1);
    await service.change(org, box.id, kind, child, true, user, 'OPERATOR');
  }
  assert.equal(await db.aggregationRelation.count(), 0);
  const rows = await db.outboxEvent.findMany();
  assert.equal(rows.length, 4);
  assert.deepEqual(
    new Set(rows.map((r) => r.eventType)),
    new Set([
      'aggregation.item-aggregated',
      'aggregation.item-disaggregated',
      'aggregation.container-aggregated',
      'aggregation.container-disaggregated',
    ]),
  );
  await assert.rejects(
    service.change(
      randomUUID(),
      box.id,
      'containers',
      inner.id,
      false,
      user,
      'OPERATOR',
    ),
  );
  assert.equal(await db.outboxEvent.count(), 4);
});

async function seedShipment(db, org = randomUUID()) {
  return db.shipment.create({
    data: {
      organizationId: org,
      shipmentNumber: randomUUID(),
      sourceFacilityId: randomUUID(),
      destinationFacilityId: randomUUID(),
      status: 'READY',
      contents: {
        create: {
          kind: 'items',
          referenceId: randomUUID(),
        },
      },
    },
    include: { contents: true },
  });
}
function shipmentService(db) {
  return new ShipmentService(
    db,
    { validate: async () => ({}) },
    new ShipmentCapture(new ConfigService(), unavailable),
  );
}
test('Phase 12 Shipment dispatch and receive persist atomically; duplicate outbox identity rolls back dispatch', async (t) => {
  const db = await isolated('shipment', t),
    row = await seedShipment(db),
    service = shipmentService(db);
  for (const action of ['dispatch', 'receive'])
    await service.transition(
      row.organizationId,
      row.id,
      action,
      randomUUID(),
      'OPERATOR',
    );
  assert.equal(
    (await db.shipment.findUnique({ where: { id: row.id } })).status,
    'RECEIVED',
  );
  assert.deepEqual(
    new Set((await db.outboxEvent.findMany()).map((r) => r.eventType)),
    new Set(['shipment.dispatched', 'shipment.received']),
  );
  const blocked = await seedShipment(db);
  const collision = event(blocked.organizationId);
  collision.eventId = `shipment:${blocked.id}:dispatch`;
  await pending(db, collision);
  await assert.rejects(
    service.transition(
      blocked.organizationId,
      blocked.id,
      'dispatch',
      randomUUID(),
      'OPERATOR',
    ),
    (e) => e.code === 'P2002',
  );
  const unchanged = await db.shipment.findUnique({ where: { id: blocked.id } });
  assert.equal(unchanged.status, 'READY');
  assert.equal(unchanged.dispatchedAt, null);
  assert.equal(await db.outboxEvent.count(), 3);
});

test('Phase 12 publisher acknowledges stored envelopes and durably backs off, sanitizes errors and stops at retry limit', async (t) => {
  const db = await isolated('serialization', t),
    e = await pending(db);
  const settings = config({ OUTBOX_MAX_ATTEMPTS: 2 });
  const worker = publisher(db, unavailable, settings);
  await worker.runOnce();
  let row = await db.outboxEvent.findUnique({ where: { eventId: e.eventId } });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, 'PUBLISH_FAILED');
  assert.ok(row.availableAt > row.updatedAt);
  assert.ok(!JSON.stringify(row).includes('do-not-store'));
  await worker.runOnce();
  assert.equal(
    (await db.outboxEvent.findUnique({ where: { id: row.id } })).attempts,
    1,
  );
  await db.outboxEvent.update({
    where: { id: row.id },
    data: { availableAt: new Date(0) },
  });
  await worker.runOnce();
  row = await db.outboxEvent.findUnique({ where: { id: row.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 2);
  await worker.runOnce();
  assert.equal(
    (await db.outboxEvent.findUnique({ where: { id: row.id } })).attempts,
    2,
  );
  // Operator requeue preserves envelope identity.
  await db.outboxEvent.update({
    where: { id: row.id },
    data: { status: 'PENDING', attempts: 0, availableAt: new Date(0) },
  });
  const sent = [];
  await publisher(db, { publish: async (e) => sent.push(e) }).runOnce();
  row = await db.outboxEvent.findUnique({ where: { id: row.id } });
  assert.deepEqual(sent, [e]);
  assert.equal(row.status, 'PUBLISHED');
  assert.ok(row.publishedAt);
  assert.equal(row.lastError, null);
});

test('Phase 12 parallel workers claim disjoint batches using PostgreSQL locks', async (t) => {
  const db = await isolated('serialization', t),
    sent = [];
  for (let n = 0; n < 8; n++) await pending(db);
  const sender = {
    publish: async (e) => {
      await new Promise((r) => setTimeout(r, 5));
      sent.push(e.eventId);
    },
  };
  await Promise.all(
    Array.from({ length: 4 }, () =>
      publisher(db, sender, config({ OUTBOX_BATCH_SIZE: 2 })).runOnce(),
    ),
  );
  assert.equal(sent.length, 8);
  assert.equal(new Set(sent).size, 8);
  assert.equal(
    await db.outboxEvent.count({ where: { status: 'PUBLISHED', attempts: 1 } }),
    8,
  );
});

test('Phase 12 expired claims recover; stale owners cannot acknowledge or reschedule a newer claim', async (t) => {
  const db = await isolated('serialization', t),
    e = await pending(db),
    store = new PostgresOutboxStore(db);
  const [first] = await store.claim(config());
  await db.outboxEvent.update({
    where: { id: first.id },
    data: { availableAt: new Date(0) },
  });
  const [second] = await store.claim(config());
  assert.notEqual(first.claimToken, second.claimToken);
  assert.equal(second.attempts, 2);
  assert.equal(await store.published(first), 0);
  assert.equal(await store.retry(first, 100, false), 0);
  assert.equal(await store.published(second), 1);
  assert.equal(
    (await db.outboxEvent.findUnique({ where: { eventId: e.eventId } })).status,
    'PUBLISHED',
  );
  const another = await pending(db);
  const [last] = await store.claim(config({ OUTBOX_MAX_ATTEMPTS: 1 }));
  await db.outboxEvent.update({
    where: { id: last.id },
    data: { availableAt: new Date(0) },
  });
  await store.claim(config({ OUTBOX_MAX_ATTEMPTS: 1 }));
  assert.equal(
    (await db.outboxEvent.findUnique({ where: { eventId: another.eventId } }))
      .status,
    'FAILED',
  );
});

test('Phase 12 publish-before-ack crash redelivers same event identity and Traceability has one effect', async (t) => {
  const db = await isolated('serialization', t),
    trace = new TraceService(await traceDB(t)),
    e = await pending(db);
  let delivered = 0;
  const sender = {
    publish: async (input) => {
      delivered++;
      await trace.consume(input);
    },
  };
  const failingStore = new PostgresOutboxStore(db);
  failingStore.published = async () => {
    throw new Error('process crashed before acknowledgement update');
  };
  await assert.rejects(
    publisher(db, sender, config(), failingStore).runOnce(),
    /process crashed/,
  );
  const before = await db.outboxEvent.findUnique({
    where: { eventId: e.eventId },
  });
  assert.equal(before.status, 'PUBLISHING');
  await db.outboxEvent.update({
    where: { id: before.id },
    data: { availableAt: new Date(0) },
  });
  await publisher(db, sender).runOnce();
  assert.equal(delivered, 2);
  assert.equal(
    await trace.db.traceEvent.count({ where: { eventId: e.eventId } }),
    1,
  );
  assert.equal(
    await trace.db.processedEvent.count({ where: { eventId: e.eventId } }),
    1,
  );
  assert.equal(
    (await db.outboxEvent.findUnique({ where: { id: before.id } })).status,
    'PUBLISHED',
  );
});

test('Phase 12 durable consumer atomically deduplicates concurrent replays, preserves organization isolation and resolves prior HTTP capture', async (t) => {
  const db = await traceDB(t),
    trace = new TraceService(db),
    e = event();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => trace.consume(e)),
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(
    (
      await trace.consume({
        ...e,
        eventId: ` ${e.eventId} `,
        correlationId: undefined,
      })
    ).id,
    results[0].id,
  );
  assert.equal(await db.traceEvent.count({ where: { eventId: e.eventId } }), 1);
  assert.equal(
    await db.processedEvent.count({ where: { eventId: e.eventId } }),
    1,
  );
  await assert.rejects(
    trace.consume({ ...e, organizationId: randomUUID() }),
    (e) => e.getStatus() === 409,
  );
  await assert.rejects(
    trace.consume({ ...e, payload: { ...e.payload, disposition: 'changed' } }),
    (e) => e.getStatus() === 409,
  );
  await assert.rejects(
    trace.get(randomUUID(), e.eventId),
    (e) => e.getStatus() === 404,
  );
  const http = event();
  const captured = await trace.capture(
    http.organizationId,
    toTrace(http),
    http.producer,
  );
  assert.equal((await trace.consume(http)).id, captured.id);
});

test('Phase 12 consumer rolls back trace and receipt on transient persistence failure, then retries safely', async (t) => {
  const db = await traceDB(t),
    e = event();
  const failing = db.$extends({
    query: {
      processedEvent: {
        create: async () => {
          throw new Error('temporary receipt persistence failure');
        },
      },
    },
  });
  await assert.rejects(
    new TraceService(failing).consume(e),
    /temporary receipt/,
  );
  assert.equal(await db.traceEvent.count({ where: { eventId: e.eventId } }), 0);
  assert.equal(
    await db.processedEvent.count({ where: { eventId: e.eventId } }),
    0,
  );
  const trace = new TraceService(db);
  await trace.consume(e);
  await trace.consume(e);
  assert.equal(await db.traceEvent.count({ where: { eventId: e.eventId } }), 1);
  const messaging = new Messaging(new ConfigService());
  let calls = 0;
  for (const raw of ['{bad', '{}', JSON.stringify({ ...e, eventVersion: 2 })])
    await messaging.handle(raw, async () => calls++);
  assert.equal(calls, 0);
});

test('Phase 12 retention deletes only old acknowledged rows in bounded batches', async (t) => {
  const db = await isolated('serialization', t),
    rows = [];
  for (let n = 0; n < 6; n++) rows.push(await pending(db));
  const old = new Date(Date.now() - 20 * 86400000);
  for (let n = 0; n < 3; n++)
    await db.outboxEvent.update({
      where: { eventId: rows[n].eventId },
      data: { status: 'PUBLISHED', publishedAt: old },
    });
  await db.outboxEvent.update({
    where: { eventId: rows[3].eventId },
    data: { status: 'FAILED', createdAt: old },
  });
  await db.outboxEvent.update({
    where: { eventId: rows[4].eventId },
    data: { status: 'PUBLISHING', createdAt: old },
  });
  await db.outboxEvent.update({
    where: { eventId: rows[5].eventId },
    data: { createdAt: old },
  });
  const store = new PostgresOutboxStore(db);
  assert.equal(await store.cleanup(7, 2), 2);
  assert.equal(await store.cleanup(7, 2), 1);
  assert.equal(await db.outboxEvent.count(), 3);
  assert.deepEqual(
    new Set((await db.outboxEvent.findMany()).map((r) => r.status)),
    new Set(['PENDING', 'PUBLISHING', 'FAILED']),
  );
});

test('Phase 12 publisher shutdown drains in-flight publication and does not schedule more claims', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let claims = 0;
  let releases = 0;
  const e = event();
  const row = {
    id: randomUUID(),
    ...e,
    envelope: e,
    attempts: 1,
    claimToken: randomUUID(),
  };
  const store = {
    claim: async () => {
      claims++;
      return [row, { ...row, id: randomUUID() }];
    },
    published: async () => 1,
    release: async () => releases++,
    cleanup: async () => 0,
  };
  const worker = new OutboxPublisher(
    store,
    { publish: async () => gate },
    config(),
    e.producer,
  );
  worker.start();
  while (!claims) await new Promise((r) => setTimeout(r, 5));
  let stopped = false;
  const stopping = worker.stop().then(() => (stopped = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(worker.status().running, false);
  assert.equal(claims, 1);
  assert.equal(releases, 1);
});

test('Phase 12 durable-producer startup tolerates Kafka connection failure and reconnects later', async () => {
  const messaging = new Messaging(
    new ConfigService({
      EVENT_TRANSPORT: 'kafka',
      KAFKA_BROKERS: 'localhost:9092',
    }),
    true,
  );
  let offline = true,
    sent = 0;
  messaging.kafka = {
    producer: () => ({
      events: { CONNECT: 'connect', DISCONNECT: 'disconnect' },
      on: () => {},
      connect: async () => {
        if (offline) throw new Error('offline');
      },
      send: async () => sent++,
    }),
  };
  await messaging.onModuleInit();
  offline = false;
  await messaging.publish(event());
  assert.equal(sent, 1);
});

test(
  'Phase 12 business operation -> outbox -> real Kafka -> Traceability -> replay has one durable effect',
  { timeout: 90000 },
  async (t) => {
    const db = await isolated('serialization', t),
      traceDb = await traceDB(t),
      trace = new TraceService(traceDb);
    const messaging = new Messaging(
      new ConfigService({
        EVENT_TRANSPORT: 'kafka',
        KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
        KAFKA_CLIENT_ID: `phase12-${randomUUID()}`,
        KAFKA_CONSUMER_GROUP_ID: `phase12-${randomUUID()}`,
      }),
    );
    t.after(() => messaging.onModuleDestroy());
    await messaging.onModuleInit();
    await new TraceConsumer(messaging, trace).onApplicationBootstrap();
    const row = await seedSerial(db);
    await commission(serialService(db, row), row);
    const outbox = await db.outboxEvent.findFirstOrThrow({
      where: { organizationId: row.organizationId },
    });
    assert.equal(outbox.status, 'PENDING');
    await publisher(db, messaging).runOnce();
    assert.equal(
      (await db.outboxEvent.findUnique({ where: { id: outbox.id } })).status,
      'PUBLISHED',
    );
    const deadline = Date.now() + 45000;
    while (
      !(await traceDb.processedEvent.findUnique({
        where: { eventId: outbox.eventId },
      }))
    ) {
      if (Date.now() > deadline)
        assert.fail('Outbox Kafka consumer did not complete');
      await new Promise((r) => setTimeout(r, 100));
    }
    await messaging.publish(outbox.envelope);
    await trace.consume(outbox.envelope);
    assert.equal(
      await traceDb.traceEvent.count({ where: { eventId: outbox.eventId } }),
      1,
    );
    assert.equal(
      await traceDb.processedEvent.count({
        where: { eventId: outbox.eventId },
      }),
      1,
    );
  },
);

test('Phase 12 live batch renewal prevents another worker reclaiming an active send', async (t) => {
  const db = await isolated('serialization', t);
  await pending(db);
  let release;
  const gate = new Promise((r) => (release = r));
  let sending = false;
  const worker = publisher(
    db,
    {
      publish: async () => {
        sending = true;
        await gate;
      },
    },
    config({ OUTBOX_LEASE_MS: 3000 }),
  );
  const publication = worker.runOnce();
  try {
    while (!sending) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 3200));
    assert.deepEqual(await new PostgresOutboxStore(db).claim(config()), []);
  } finally {
    release();
    await publication;
  }
  assert.equal(
    await db.outboxEvent.count({ where: { status: 'PUBLISHED', attempts: 1 } }),
    1,
  );
});

test('Phase 12 operational readiness reports database/worker availability independently of Kafka backlog', async () => {
  const {
    HealthController,
  } = require('../services/serialization-service/dist/health.controller');
  let storageAvailable = true;
  const health = new HealthController(
    {
      $queryRaw: async () => [],
      outbox: { status: () => ({ running: true, storageAvailable }) },
    },
    {
      enabled: true,
      ready: async () => {
        throw new Error('Kafka offline');
      },
    },
  );
  assert.equal((await health.ready()).status, 'ok');
  storageAvailable = false;
  await assert.rejects(health.ready(), (e) => e.getStatus() === 503);
});
