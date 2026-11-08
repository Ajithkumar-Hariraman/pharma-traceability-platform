import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DynamoStore } from '@pharma/dynamodb';
import { normalizeGtin, normalizeSerialNumber } from '@pharma/contracts';
import type { DomainEvent } from '@pharma/messaging';
import { z } from 'zod';
import { cachedVerificationSchema } from './verification-result.schema';
import {
  ReferenceClient,
  serialSchema,
  gtinSchema,
  type Identity,
} from './reference.client';

export function projectionKey(org: string, gtin: string, serial: string) {
  const g = normalizeGtin(gtin),
    s = normalizeSerialNumber(serial);
  if (!g || !s || !org) throw new Error('Invalid projection identity');
  return { PK: `ORG#${org}#GTIN#${g}`, SK: `SERIAL#${s}` };
}
export const projectionSchema = z
  .object({
    PK: z.string(),
    SK: z.string(),
    organizationId: z.string().uuid(),
    gtin: z.string(),
    serialNumber: z.string(),
    serializedItemId: z.string().uuid(),
    productId: z.string().uuid(),
    batchId: z.string().uuid(),
    gtinId: z.string().uuid(),
    productName: z.string(),
    lotNumber: z.string(),
    expiryDate: z.iso.date().nullable(),
    productStatus: z.enum(['ACTIVE', 'INACTIVE']),
    gtinStatus: z.enum(['ACTIVE', 'INACTIVE']),
    batchStatus: z.string(),
    activeRecall: z.boolean(),
    recallId: z.string().uuid().optional(),
    verificationStatus: z.enum([
      'VALID',
      'RECALLED',
      'QUARANTINED',
      'DECOMMISSIONED',
      'UNKNOWN',
    ]),
    serializationStatus: z.enum([
      'CREATED',
      'COMMISSIONED',
      'QUARANTINED',
      'DECOMMISSIONED',
    ]),
    generation: z.string(),
    revision: z.number().int(),
    updatedAt: z.iso.datetime(),
    projectionVersion: z.literal(1),
    lastEventId: z.string(),
    lastEventTime: z.iso.datetime({ offset: true }),
    response: cachedVerificationSchema,
  })
  .superRefine((p, ctx) => {
    if (
      p.verificationStatus !== p.response.result ||
      p.productName !== p.response.productName ||
      p.lotNumber !== p.response.lotNumber ||
      p.expiryDate !== p.response.expiryDate ||
      Date.parse(p.response.verifiedAt) !== p.revision ||
      (p.response.result === 'VALID' &&
        (p.serializationStatus !== 'COMMISSIONED' ||
          p.productStatus !== 'ACTIVE' ||
          p.gtinStatus !== 'ACTIVE' ||
          p.batchStatus !== 'ACTIVE' ||
          p.activeRecall)) ||
      (p.activeRecall && p.response.result !== 'RECALLED')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Inconsistent projection facts',
      });
  });
@Injectable()
export class VerificationProjection {
  private readonly logger = new Logger('VerificationProjection');
  constructor(
    readonly store: DynamoStore,
    private readonly refs: ReferenceClient,
  ) {}
  get enabled() {
    return this.store.settings.VERIFICATION_PROJECTION_ENABLED;
  }
  private epochKey(org: string) {
    return { PK: `ORG#${org}`, SK: 'GENERATION' };
  }
  async generation(org: string) {
    return String(
      (await this.store.get(this.epochKey(org)))?.generation ?? 'initial',
    );
  }
  async read(identity: Identity, gtin: string, serial: string) {
    if (!this.enabled) return;
    const start = Date.now();
    const key = projectionKey(identity.organizationId, gtin, serial);
    const parsed = projectionSchema.safeParse(await this.store.get(key));
    if (!parsed.success) return;
    const p = parsed.data;
    const age = Date.now() - p.revision;
    if (
      p.organizationId !== identity.organizationId ||
      p.PK !== key.PK ||
      p.SK !== key.SK ||
      p.gtin !== gtin ||
      p.serialNumber !== serial ||
      p.response.gtin !== gtin ||
      p.response.serialNumber !== serial ||
      age < 0 ||
      age >= 30000 ||
      p.generation !== (await this.generation(identity.organizationId))
    )
      return;
    if (
      p.response.expiryDate &&
      p.response.result === 'VALID' &&
      p.response.expiryDate < new Date().toISOString().slice(0, 10)
    )
      return;
    this.logger.log({
      message: 'Verification projection lookup',
      projectionHit: true,
      latencyMs: Date.now() - start,
    });
    // Preserve snapshot age through Redis so two cache layers cannot extend freshness.
    return p.response;
  }
  async write(
    identity: Identity,
    facts: Record<string, unknown>,
    response: import('@pharma/contracts').VerificationResult,
    revision: number,
    generation: string,
    event?: DomainEvent,
  ) {
    const item = projectionSchema.parse({
      ...projectionKey(
        identity.organizationId,
        response.gtin,
        response.serialNumber,
      ),
      ...facts,
      organizationId: identity.organizationId,
      gtin: response.gtin,
      serialNumber: response.serialNumber,
      response,
      generation,
      revision,
      updatedAt: new Date().toISOString(),
      projectionVersion: 1,
      lastEventId: event?.eventId ?? `refresh:${randomUUID()}`,
      lastEventTime: event?.occurredAt ?? new Date(revision).toISOString(),
    });
    const applied = await this.store.put(item, true);
    this.logger.log({
      message: 'Verification projection write',
      eventId: item.lastEventId,
      eventType: event?.eventType,
      projectionOperation: 'put',
      conditionalOutcome: applied ? 'applied' : 'superseded',
    });
  }
  async rebuild(
    identity: Identity,
    refresh: (
      input: { gtin: string; serialNumber: string },
      event?: DomainEvent,
    ) => Promise<unknown>,
    after?: string,
    maxPages = 1,
    event?: DomainEvent,
  ) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
      throw new Error('Invalid page budget');
    let cursor = after;
    for (let page = 0; page < maxPages; page++) {
      const path = `/internal/organizations/${identity.organizationId}/serials/projection-page${cursor ? `?after=${cursor}` : ''}`;
      const data = await this.refs.get(
        'SERIALIZATION',
        path,
        identity,
        z.object({
          organizationId: z.string().uuid(),
          items: z.array(serialSchema).max(50),
        }),
      );
      for (const row of data.items) {
        if (row.organizationId !== identity.organizationId)
          throw new Error('Projection tenant mismatch');
        const gtin = await this.refs.get(
          'PRODUCT',
          `/organizations/${identity.organizationId}/products/${row.productId}/gtins/${row.gtinId}`,
          identity,
          gtinSchema,
        );
        if (gtin.id !== row.gtinId || gtin.productId !== row.productId)
          throw new Error('Projection GTIN mismatch');
        await refresh(
          { gtin: gtin.gtin, serialNumber: row.serialNumber },
          event,
        );
      }
      if (data.items.length < 50) return undefined;
      const next = data.items.at(-1)!.id;
      if (next === cursor) throw new Error('Non-advancing projection cursor');
      cursor = next;
    }
    return cursor;
  }
  async consume(
    event: DomainEvent,
    refresh: (
      identity: Identity,
      input: { gtin: string; serialNumber: string },
      event: DomainEvent,
    ) => Promise<unknown>,
  ) {
    if (
      !this.enabled ||
      (!event.eventType.startsWith('serialization.') &&
        !event.eventType.startsWith('recall.'))
    )
      return;
    // Re-read current owners instead of applying historical deltas; replay never restores old state.
    await this.store.put({
      ...this.epochKey(event.organizationId),
      generation: randomUUID(),
    });
    const identity: Identity = {
      organizationId: event.organizationId,
      userId: event.aggregateId,
      role: 'ORG_ADMIN',
    };
    if (event.eventType.startsWith('serialization.')) {
      const row = await this.refs.get(
        'SERIALIZATION',
        `/internal/organizations/${identity.organizationId}/serials/${event.aggregateId}/validation`,
        identity,
        serialSchema,
      );
      if (row.id !== event.aggregateId)
        throw new Error('Projection item mismatch');
      const gtin = await this.refs.get(
        'PRODUCT',
        `/organizations/${identity.organizationId}/products/${row.productId}/gtins/${row.gtinId}`,
        identity,
        gtinSchema,
      );
      if (gtin.id !== row.gtinId || gtin.productId !== row.productId)
        throw new Error('Projection GTIN mismatch');
      await refresh(
        identity,
        { gtin: gtin.gtin, serialNumber: row.serialNumber },
        event,
      );
      return;
    }
    let cursor: string | undefined;
    do {
      cursor = await this.rebuild(
        identity,
        (input) => refresh(identity, input, event),
        cursor,
        1,
        event,
      );
    } while (cursor);
  }
}
