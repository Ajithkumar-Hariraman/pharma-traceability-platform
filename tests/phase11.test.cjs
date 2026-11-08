const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const {
  ConfigService,
} = require('../packages/messaging/node_modules/@nestjs/config');
const { Kafka } = require('../packages/messaging/node_modules/kafkajs');
const {
  Messaging,
  eventSchema,
  fromTrace,
  toTrace,
  aggregationEvent,
  TOPIC,
} = require('../packages/messaging/dist');
const { validateKafkaEnvironment } = require('../packages/config/dist');
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
  ShipmentService,
} = require('../services/shipment-service/dist/shipment.service');
const {
  AggregationService,
} = require('../services/aggregation-service/dist/aggregation.service');
const {
  PrismaService: AggregationDB,
} = require('../services/aggregation-service/dist/persistence/prisma.service');
const {
  PrismaService: TraceDB,
} = require('../services/traceability-service/dist/persistence/prisma.service');
const {
  TraceService,
} = require('../services/traceability-service/dist/trace.service');
const {
  TraceConsumer,
} = require('../services/traceability-service/dist/trace-consumer');
const env = (name) =>
  parseEnv(readFileSync(`services/${name}-service/.env`, 'utf8'));
function object(overrides = {}) {
  return {
    organizationId: randomUUID(),
    eventId: randomUUID(),
    eventType: 'OBJECT',
    action: 'ADD',
    businessStep: 'commissioning',
    eventTime: new Date().toISOString(),
    serializedItemId: randomUUID(),
    batchId: randomUUID(),
    productId: randomUUID(),
    gtinId: randomUUID(),
    ...overrides,
  };
}
const settings = () => ({
  EVENT_TRANSPORT: 'kafka',
  KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
  KAFKA_CLIENT_ID: `phase11-${randomUUID()}`,
  KAFKA_CONSUMER_GROUP_ID: `phase11-${randomUUID()}`,
});

test('Phase 11 envelope validates versions, ownership, timestamps, aggregate identity and tenant overrides', () => {
  const valid = fromTrace(object());
  assert.equal(
    eventSchema.parse({ ...valid, correlationId: 'request-123' }).eventVersion,
    1,
  );
  for (const patch of [
    { eventVersion: 2 },
    { eventType: 'unknown' },
    { organizationId: 'bad' },
    { occurredAt: 'yesterday' },
    { producer: 'shipment-service' },
    { aggregateId: randomUUID() },
    { aggregateType: 'shipment' },
    { payload: { ...valid.payload, organizationId: randomUUID() } },
    { payload: { ...valid.payload, batchId: undefined } },
  ]) {
    assert.equal(eventSchema.safeParse({ ...valid, ...patch }).success, false);
  }
});

test('Phase 11 Kafka config validates opt-in, broker addresses, timeouts, TLS and SASL', () => {
  assert.equal(validateKafkaEnvironment({}).EVENT_TRANSPORT, 'http');
  const config = validateKafkaEnvironment(settings());
  assert.equal(
    validateKafkaEnvironment(config).KAFKA_REQUEST_TIMEOUT_MS,
    10000,
  );
  for (const patch of [
    { KAFKA_BROKERS: '' },
    { KAFKA_BROKERS: 'http://localhost:9092' },
    { KAFKA_BROKERS: 'host:99999' },
    { KAFKA_REQUEST_TIMEOUT_MS: 'NaN' },
    { KAFKA_CONNECTION_TIMEOUT_MS: 0 },
    { KAFKA_CLIENT_ID: ' ' },
    { KAFKA_CONSUMER_GROUP_ID: '' },
    { KAFKA_SSL: 'yes' },
    { EVENT_TRANSPORT: 'both' },
    { KAFKA_SASL_MECHANISM: 'plain' },
  ])
    assert.throws(() => validateKafkaEnvironment({ ...settings(), ...patch }));
  const tls = validateKafkaEnvironment({
    ...settings(),
    KAFKA_SSL: 'true',
    KAFKA_SASL_MECHANISM: 'scram-sha-512',
    KAFKA_SASL_USERNAME: 'user',
    KAFKA_SASL_PASSWORD: 'password',
  });
  assert.equal(validateKafkaEnvironment(tls).KAFKA_SSL, true);
});

test('Phase 11 serialization commands persist mapped events in the business transaction', async () => {
  const sent = [];
  const messaging = { enabled: true, publish: async (e) => sent.push(e) };
  const row = {
    ...object(),
    id: randomUUID(),
    status: 'CREATED',
    updatedAt: new Date(),
  };
  const repo = {
    find: async () => row,
    transition: async (_o, _id, _from, status, afterMutation) => {
      row.status = status;
      await afterMutation?.(
        {
          outboxEvent: { create: async ({ data }) => sent.push(data.envelope) },
        },
        row,
      );
      return { ...row };
    },
  };
  const service = new SerializationService(
    repo,
    {
      validate: async () => ({
        status: 'ACTIVE',
        productId: row.productId,
        gtinId: row.gtinId,
      }),
    },
    new SerialCapture(new ConfigService(), messaging),
  );
  for (const [command, name, action] of [
    ['commission', 'commissioned', 'ADD'],
    ['quarantine', 'quarantined', 'OBSERVE'],
    ['decommission', 'decommissioned', 'DELETE'],
  ]) {
    if (command === 'decommission') row.status = 'COMMISSIONED';
    await service.command(
      row.organizationId,
      row.id,
      command,
      {},
      randomUUID(),
      'ORG_ADMIN',
    );
    assert.equal(sent.at(-1).eventType, `serialization.${name}`);
    assert.equal(toTrace(sent.at(-1)).action, action);
    assert.equal(sent.at(-1).organizationId, row.organizationId);
  }
  await assert.rejects(
    service.command(
      row.organizationId,
      row.id,
      'commission',
      {},
      randomUUID(),
      'ORG_ADMIN',
    ),
  );
  assert.equal(sent.length, 3);
  row.status = 'CREATED';
  messaging.publish = async () => {
    throw new Error('Kafka unavailable');
  };
  await service.command(
    row.organizationId,
    row.id,
    'commission',
    {},
    randomUUID(),
    'ORG_ADMIN',
  );
  assert.equal(row.status, 'COMMISSIONED');
});

test('Phase 11 shipment dispatch and receiving persist semantic events atomically', async () => {
  const sent = [];
  const row = {
    id: randomUUID(),
    organizationId: randomUUID(),
    shipmentNumber: 'P11',
    sourceFacilityId: randomUUID(),
    destinationFacilityId: randomUUID(),
    status: 'READY',
    contents: [{ kind: 'items', referenceId: randomUUID() }],
  };
  const tx = {
    outboxEvent: { create: async ({ data }) => sent.push(data.envelope) },
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    shipment: {
      findFirst: async () => row,
      update: async ({ data }) => Object.assign(row, data),
    },
  };
  const db = { $transaction: async (fn) => fn(tx) };
  const service = new ShipmentService(
    db,
    { validate: async () => ({}) },
    new ShipmentCapture(new ConfigService(), {
      enabled: true,
      publish: async (e) => sent.push(e),
    }),
  );
  for (const command of ['dispatch', 'receive'])
    await service.transition(
      row.organizationId,
      row.id,
      command,
      randomUUID(),
      'ORG_ADMIN',
    );
  assert.deepEqual(
    sent.map((e) => e.eventType),
    ['shipment.dispatched', 'shipment.received'],
  );
  assert.equal(sent[0].aggregateId, row.id);
  assert.equal(sent[1].payload.facilityId, row.destinationFacilityId);
  assert.equal(row.status, 'RECEIVED');
});

test('Phase 11 aggregation persists all four events and succeeds while Kafka is unavailable', async (t) => {
  const db = new AggregationDB(new ConfigService(env('aggregation')));
  await db.$connect();
  const org = randomUUID(),
    user = randomUUID(),
    sent = [];
  t.after(async () => {
    await db.aggregationRelation.deleteMany({ where: { organizationId: org } });
    await db.aggregateContainer.deleteMany({ where: { organizationId: org } });
    await db.outboxEvent.deleteMany({ where: { organizationId: org } });
    await db.$disconnect();
  });
  const messaging = { enabled: true, publish: async (e) => sent.push(e) };
  const service = new AggregationService(
    db,
    { validate: async () => ({ status: 'COMMISSIONED' }) },
    messaging,
  );
  const inner = await service.create(org, {
    containerCode: randomUUID(),
    packagingLevel: 'INNER',
  });
  const box = await service.create(org, {
    containerCode: randomUUID(),
    packagingLevel: 'CASE',
  });
  for (const [type, child] of [
    ['items', randomUUID()],
    ['containers', inner.id],
  ])
    for (const remove of [false, true])
      await service.change(org, box.id, type, child, remove, user, 'OPERATOR');
  sent.push(
    ...(
      await db.outboxEvent.findMany({
        where: { organizationId: org },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.envelope),
  );
  assert.deepEqual(
    sent.map((e) => e.eventType),
    [
      'aggregation.item-aggregated',
      'aggregation.item-disaggregated',
      'aggregation.container-aggregated',
      'aggregation.container-disaggregated',
    ],
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
  assert.equal(sent.length, 4);
  messaging.publish = async () => {
    throw new Error('Kafka unavailable');
  };
  await service.change(
    org,
    box.id,
    'containers',
    inner.id,
    false,
    user,
    'OPERATOR',
  );
  assert.equal(
    await db.outboxEvent.count({ where: { organizationId: org } }),
    5,
  );
  assert.equal(
    await db.aggregationRelation.count({ where: { organizationId: org } }),
    1,
  );
});

test('Phase 11 malformed messages and permanent rejection do not poison the loop; transient failure is retryable', async () => {
  const messaging = new Messaging(new ConfigService());
  let calls = 0;
  for (const raw of [
    undefined,
    '{bad',
    '{}',
    JSON.stringify({ ...fromTrace(object()), eventVersion: 2 }),
  ])
    await messaging.handle(raw, async () => calls++);
  assert.equal(calls, 0);
  const raw = JSON.stringify(fromTrace(object()));
  for (const status of [400, 409])
    await messaging.handle(raw, async () => {
      throw { getStatus: () => status };
    });
  await assert.rejects(
    messaging.handle(raw, async () => {
      throw new Error('database offline');
    }),
  );
  await messaging.handle(raw, async () => calls++);
  assert.equal(calls, 1);
});

test('Phase 11 producer failures retain recoverable envelope and fail readiness', async () => {
  const messaging = new Messaging(new ConfigService(settings()));
  await assert.rejects(messaging.ready());
  const event = fromTrace(object());
  await assert.rejects(
    messaging.publish(event),
    (e) =>
      e.getResponse().businessStateChanged &&
      e.getResponse().event.eventId === event.eventId,
  );
  messaging.producer = {
    send: async () => {
      throw new Error('broker offline');
    },
  };
  await assert.rejects(
    messaging.publish(event),
    (e) => e.getResponse().code === 'EVENT_PUBLISH_FAILED',
  );
  assert.equal(messaging.connected, false);
});

test(
  'Phase 11 real Kafka to Traceability: all domain events, malformed records, retry, replay and organization isolation',
  { timeout: 90000 },
  async (t) => {
    const config = new ConfigService(settings());
    const messaging = new Messaging(config);
    const db = new TraceDB(new ConfigService(env('traceability')));
    await db.$connect();
    const org = randomUUID(),
      other = randomUUID();
    t.after(async () => {
      await messaging.onModuleDestroy();
      await db.$disconnect();
    });
    const service = new TraceService(db);
    let failOnce = true;
    const capture = service.capture.bind(service);
    service.capture = async (...args) => {
      if (args[0] === org && failOnce) {
        failOnce = false;
        throw new Error('temporary DB failure');
      }
      return capture(...args);
    };
    await messaging.onModuleInit();
    await new TraceConsumer(messaging, service).onApplicationBootstrap();
    const events = ['commissioning', 'holding', 'decommissioning'].map(
      (businessStep) =>
        fromTrace(
          object({
            organizationId: org,
            businessStep,
            action:
              businessStep === 'commissioning'
                ? 'ADD'
                : businessStep === 'holding'
                  ? 'OBSERVE'
                  : 'DELETE',
          }),
        ),
    );
    for (const type of ['items', 'containers'])
      for (const remove of [false, true])
        events.push(
          aggregationEvent(org, randomUUID(), randomUUID(), type, remove),
        );
    for (const businessStep of ['shipping', 'receiving']) {
      const facility = randomUUID();
      events.push(
        fromTrace({
          organizationId: org,
          eventId: randomUUID(),
          eventType: 'TRANSACTION',
          action: 'OBSERVE',
          businessStep,
          eventTime: new Date().toISOString(),
          facilityId: facility,
          metadata: {
            shipmentId: randomUUID(),
            shipmentNumber: 'P11',
            sourceFacilityId:
              businessStep === 'shipping' ? facility : randomUUID(),
            destinationFacilityId:
              businessStep === 'receiving' ? facility : randomUUID(),
            contents: [{ kind: 'items', referenceId: randomUUID() }],
          },
        }),
      );
    }
    const foreign = fromTrace(object({ organizationId: other }));
    const rawProducer = new Kafka({
      clientId: 'phase11-malformed',
      brokers: config.get('KAFKA_BROKERS').split(','),
    }).producer();
    await rawProducer.connect();
    try {
      await rawProducer.send({
        topic: TOPIC,
        messages: [
          { value: 'not-json' },
          {
            value: JSON.stringify({
              ...events[0],
              payload: { ...events[0].payload, organizationId: other },
            }),
          },
        ],
      });
    } finally {
      await rawProducer.disconnect();
    }
    for (const e of [...events, events[0], foreign]) await messaging.publish(e);
    const deadline = Date.now() + 45000;
    while (
      (await db.traceEvent.count({
        where: { organizationId: { in: [org, other] } },
      })) < 10
    ) {
      if (Date.now() > deadline)
        assert.fail('Kafka consumer did not persist all events');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      await db.traceEvent.count({ where: { organizationId: org } }),
      9,
    );
    for (const e of events) {
      const row = await service.get(org, e.eventId);
      assert.equal(row.eventType, toTrace(e).eventType);
      assert.equal(row.action, toTrace(e).action);
    }
    await assert.rejects(
      service.get(other, events[0].eventId),
      (e) => e.getStatus() === 404,
    );
    await assert.rejects(
      capture(other, toTrace(events[0]), events[0].producer),
      (e) => e.getStatus() === 400,
    );
    await assert.rejects(
      capture(
        other,
        { ...toTrace(events[0]), organizationId: other },
        events[0].producer,
      ),
      (e) => e.getStatus() === 409,
    );
    await messaging.ready(true);
  },
);

test('Phase 11 messaging lifecycle surfaces connection/subscription failures and dependency probes', async () => {
  const messaging = new Messaging(new ConfigService(settings()));
  messaging.kafka = {
    producer: () => ({
      events: { CONNECT: 'connect', DISCONNECT: 'disconnect' },
      on: () => {},
      connect: async () => {
        throw new Error('connect failed');
      },
    }),
  };
  await assert.rejects(messaging.onModuleInit(), /connect failed/);
  messaging.kafka = {
    consumer: () => ({
      events: { CRASH: 'crash', DISCONNECT: 'disconnect', GROUP_JOIN: 'join' },
      on: () => {},
      connect: async () => {},
      subscribe: async () => {
        throw new Error('subscribe failed');
      },
    }),
  };
  await assert.rejects(
    messaging.consume(async () => {}),
    /subscribe failed/,
  );
  await assert.rejects(messaging.ready(true));
  messaging.kafka = {
    admin: () => ({
      connect: async () => {
        throw new Error('broker offline');
      },
      disconnect: async () => {},
    }),
  };
  await assert.rejects(messaging.ready(), /broker offline/);
});
