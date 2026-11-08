import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Inject,
  Optional,
  type DynamicModule,
  Module,
  Global,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Partitioners, type Consumer, type Producer } from 'kafkajs';
import { z } from 'zod';
import { validateKafkaEnvironment } from '@pharma/config';
import type { TraceCapture } from '@pharma/contracts';
export const TOPIC = 'pharma.domain-events.v1';
const id = z.string().uuid();
const definitions = {
  'serialization.commissioned': [
    'serialization-service',
    'serialized-item',
    'OBJECT',
    'ADD',
    'commissioning',
  ],
  'serialization.quarantined': [
    'serialization-service',
    'serialized-item',
    'OBJECT',
    'OBSERVE',
    'holding',
  ],
  'serialization.decommissioned': [
    'serialization-service',
    'serialized-item',
    'OBJECT',
    'DELETE',
    'decommissioning',
  ],
  'aggregation.item-aggregated': [
    'aggregation-service',
    'container',
    'AGGREGATION',
    'ADD',
    'packing',
  ],
  'aggregation.item-disaggregated': [
    'aggregation-service',
    'container',
    'AGGREGATION',
    'DELETE',
    'unpacking',
  ],
  'aggregation.container-aggregated': [
    'aggregation-service',
    'container',
    'AGGREGATION',
    'ADD',
    'packing',
  ],
  'aggregation.container-disaggregated': [
    'aggregation-service',
    'container',
    'AGGREGATION',
    'DELETE',
    'unpacking',
  ],
  'shipment.dispatched': [
    'shipment-service',
    'shipment',
    'TRANSACTION',
    'OBSERVE',
    'shipping',
  ],
  'shipment.received': [
    'shipment-service',
    'shipment',
    'TRANSACTION',
    'OBSERVE',
    'receiving',
  ],
} as const;
export type EventType = keyof typeof definitions;
const payloadSchema = z
  .object({
    serializedItemId: id.optional(),
    batchId: id.optional(),
    productId: id.optional(),
    gtinId: id.optional(),
    aggregateContainerId: id.optional(),
    childContainerId: id.optional(),
    facilityId: id.optional(),
    disposition: z.string().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.json()).optional(),
  })
  .strict();
const shipmentFacts = z
  .object({
    shipmentId: id,
    shipmentNumber: z.string().min(1).max(100),
    sourceFacilityId: id,
    destinationFacilityId: id,
    contents: z
      .array(
        z
          .object({ kind: z.enum(['items', 'containers']), referenceId: id })
          .strict(),
      )
      .min(1)
      .max(100),
    correlationId: z.string().min(1).max(200).optional(),
  })
  .strict();
export const eventSchema = z
  .object({
    eventId: z.string().trim().min(1).max(200),
    eventType: z.enum(Object.keys(definitions) as [EventType, ...EventType[]]),
    eventVersion: z.literal(1),
    organizationId: id,
    aggregateType: z.enum(['serialized-item', 'container', 'shipment']),
    aggregateId: id,
    occurredAt: z.iso.datetime({ offset: true }),
    producer: z.string(),
    correlationId: z.string().min(1).max(200).optional(),
    payload: payloadSchema,
  })
  .strict()
  .superRefine((e, ctx) => {
    const d = definitions[e.eventType];
    const p = e.payload;
    const invalid =
      e.producer !== d[0] ||
      e.aggregateType !== d[1] ||
      (d[2] === 'OBJECT' &&
        (!p.serializedItemId ||
          !p.batchId ||
          !p.productId ||
          !p.gtinId ||
          e.aggregateId !== p.serializedItemId)) ||
      (d[2] === 'AGGREGATION' &&
        (e.aggregateId !== p.aggregateContainerId ||
          (e.eventType.includes('.item-')
            ? !p.serializedItemId || !!p.childContainerId
            : !p.childContainerId || !!p.serializedItemId))) ||
      (d[2] === 'TRANSACTION' &&
        (p.metadata?.shipmentId !== e.aggregateId ||
          !p.facilityId ||
          !shipmentFacts.safeParse(p.metadata).success ||
          p.facilityId !==
            (e.eventType === 'shipment.dispatched'
              ? p.metadata?.sourceFacilityId
              : p.metadata?.destinationFacilityId)));
    if (invalid)
      ctx.addIssue({
        code: 'custom',
        message: 'Event ownership or payload mismatch',
      });
  });
export type DomainEvent = z.infer<typeof eventSchema>;
export function fromTrace(event: TraceCapture): DomainEvent {
  const eventType: EventType =
    event.eventType === 'OBJECT'
      ? event.businessStep === 'commissioning'
        ? 'serialization.commissioned'
        : event.businessStep === 'decommissioning'
          ? 'serialization.decommissioned'
          : 'serialization.quarantined'
      : event.eventType === 'TRANSACTION'
        ? event.businessStep === 'shipping'
          ? 'shipment.dispatched'
          : 'shipment.received'
        : `aggregation.${event.serializedItemId ? 'item' : 'container'}-${event.action === 'ADD' ? 'aggregated' : 'disaggregated'}`;
  const d = definitions[eventType];
  if (
    event.eventType !== d[2] ||
    event.action !== d[3] ||
    (event.businessStep != null && event.businessStep !== d[4])
  )
    throw new Error('Unsupported domain event mapping');
  const {
    organizationId,
    eventId,
    eventTime,
    eventType: _type,
    action: _action,
    businessStep: _step,
    parentEventId: _parent,
    ...payload
  } = event;
  void _type;
  void _action;
  void _step;
  void _parent;
  return eventSchema.parse({
    eventId,
    eventType,
    eventVersion: 1,
    organizationId,
    aggregateType: d[1],
    aggregateId:
      event.serializedItemId && d[2] === 'OBJECT'
        ? event.serializedItemId
        : d[2] === 'AGGREGATION'
          ? event.aggregateContainerId
          : event.metadata?.shipmentId,
    occurredAt: eventTime,
    producer: d[0],
    ...(typeof event.metadata?.correlationId === 'string'
      ? { correlationId: event.metadata.correlationId }
      : {}),
    payload,
  });
}
export function toTrace(input: unknown): TraceCapture {
  const e = eventSchema.parse(input);
  const d = definitions[e.eventType];
  return {
    ...e.payload,
    organizationId: e.organizationId,
    eventId: e.eventId,
    eventTime: e.occurredAt,
    eventType: d[2],
    action: d[3],
    businessStep: d[4],
  };
}
export function aggregationEvent(
  organizationId: string,
  parentId: string,
  childId: string,
  type: 'items' | 'containers',
  remove: boolean,
): DomainEvent {
  return fromTrace({
    organizationId,
    eventId: randomUUID(),
    eventTime: new Date().toISOString(),
    eventType: 'AGGREGATION',
    action: remove ? 'DELETE' : 'ADD',
    aggregateContainerId: parentId,
    ...(type === 'items'
      ? { serializedItemId: childId }
      : { childContainerId: childId }),
  });
}
@Injectable()
export class Messaging {
  readonly enabled: boolean;
  private readonly kafka: Kafka;
  private producer?: Producer;
  private consumer?: Consumer;
  private connected = false;
  private consuming = false;
  private stopping = false;
  private readonly logger = new Logger('Messaging');
  private readonly settings;
  constructor(
    config: ConfigService,
    @Optional()
    @Inject('DURABLE_EVENT_PRODUCER')
    private readonly durableProducer = false,
  ) {
    this.settings = validateKafkaEnvironment(
      Object.fromEntries(
        [
          'EVENT_TRANSPORT',
          'KAFKA_BROKERS',
          'KAFKA_CLIENT_ID',
          'KAFKA_CONSUMER_GROUP_ID',
          'KAFKA_CONNECTION_TIMEOUT_MS',
          'KAFKA_REQUEST_TIMEOUT_MS',
          'KAFKA_SSL',
          'KAFKA_SASL_MECHANISM',
          'KAFKA_SASL_USERNAME',
          'KAFKA_SASL_PASSWORD',
        ].map((k) => [k, config.get(k)]),
      ),
    );
    const s = this.settings;
    this.enabled = s.EVENT_TRANSPORT === 'kafka';
    this.kafka = new Kafka({
      clientId: s.KAFKA_CLIENT_ID,
      brokers: s.KAFKA_BROKERS.split(','),
      connectionTimeout: s.KAFKA_CONNECTION_TIMEOUT_MS,
      requestTimeout: s.KAFKA_REQUEST_TIMEOUT_MS,
      ssl: s.KAFKA_SSL,
      ...(s.KAFKA_SASL_MECHANISM
        ? {
            sasl: {
              mechanism: s.KAFKA_SASL_MECHANISM as 'plain',
              username: String(s.KAFKA_SASL_USERNAME),
              password: String(s.KAFKA_SASL_PASSWORD),
            },
          }
        : {}),
      retry: { retries: 5, initialRetryTime: 300, maxRetryTime: 3000 },
    });
  }
  async onModuleInit() {
    if (!this.enabled) return;
    this.producer = this.kafka.producer({
      idempotent: true,
      createPartitioner: Partitioners.DefaultPartitioner,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
    });
    this.producer.on(this.producer.events.DISCONNECT, () => {
      this.connected = false;
    });
    this.producer.on(this.producer.events.CONNECT, () => {
      this.connected = true;
    });
    try {
      await this.producer.connect();
    } catch (error) {
      if (!this.durableProducer) throw error;
      this.logger.warn({
        message: 'Kafka unavailable; committed events remain in outbox',
      });
    }
  }
  async publish(input: DomainEvent) {
    const event = eventSchema.parse(input);
    try {
      if (!this.producer) throw new Error('Producer unavailable');
      if (!this.connected) await this.producer.connect();
      await this.producer.send({
        topic: TOPIC,
        acks: -1,
        messages: [
          {
            key: `${event.organizationId}:${event.aggregateType}:${event.aggregateId}`,
            value: JSON.stringify(event),
          },
        ],
      });
      this.connected = true;
    } catch {
      this.connected = false;
      this.logger.error({
        message: 'Domain event publish failed',
        eventId: event.eventId,
        eventType: event.eventType,
        organizationId: event.organizationId,
      });
      throw new ServiceUnavailableException({
        code: 'EVENT_PUBLISH_FAILED',
        businessStateChanged: true,
        message:
          'Business state committed; reconcile this event. Do not repeat the command.',
        event,
      });
    }
  }
  async consume(handler: (event: DomainEvent) => Promise<unknown>) {
    if (!this.enabled) return;
    this.consumer = this.kafka.consumer({
      groupId: this.settings.KAFKA_CONSUMER_GROUP_ID,
      allowAutoTopicCreation: false,
    });
    this.consumer.on(this.consumer.events.CRASH, () => {
      this.consuming = false;
    });
    this.consumer.on(this.consumer.events.DISCONNECT, () => {
      this.consuming = false;
    });
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => {
      this.consuming = true;
    });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    await this.consumer.run({
      eachMessage: async ({ message, partition, topic, heartbeat }) => {
        while (!this.stopping) {
          try {
            await this.handle(message.value?.toString(), handler, {
              topic,
              partition,
              offset: message.offset,
            });
            this.consuming = true;
            return;
          } catch {
            this.consuming = false;
            await heartbeat();
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        throw new Error('Consumer stopping before event persisted');
      },
    });
  }
  async handle(
    raw: string | undefined,
    handler: (event: DomainEvent) => Promise<unknown>,
    context: Record<string, unknown> = {},
  ) {
    let event: DomainEvent;
    try {
      event = eventSchema.parse(JSON.parse(raw ?? ''));
    } catch {
      this.logger.warn({
        message: 'Malformed domain event skipped',
        ...context,
      });
      return;
    }
    try {
      await handler(event);
      this.logger.log({
        message: 'Domain event captured',
        ...context,
        eventId: event.eventId,
        eventType: event.eventType,
        organizationId: event.organizationId,
        correlationId: event.correlationId,
      });
    } catch (error) {
      const status =
        error &&
        typeof error === 'object' &&
        'getStatus' in error &&
        typeof error.getStatus === 'function'
          ? error.getStatus()
          : undefined;
      this.logger.error({
        message: 'Domain event consumption failed',
        ...context,
        eventId: event.eventId,
        organizationId: event.organizationId,
        retryable: status !== 400 && status !== 409,
      });
      if (status !== 400 && status !== 409) throw error;
    }
  }
  async ready(requireConsumer = false) {
    if (!this.enabled) return;
    if (this.stopping || !this.producer || (requireConsumer && !this.consuming))
      throw new Error('Kafka unavailable');
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.fetchTopicMetadata({ topics: [TOPIC] });
      this.connected = true;
    } finally {
      await admin.disconnect();
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await this.consumer?.disconnect();
    await this.producer?.disconnect();
  }
}
@Global()
@Module({ providers: [Messaging], exports: [Messaging] })
export class MessagingModule {
  static forOutbox(): DynamicModule {
    return {
      module: MessagingModule,
      providers: [{ provide: 'DURABLE_EVENT_PRODUCER', useValue: true }],
    };
  }
}

export * from './outbox';
