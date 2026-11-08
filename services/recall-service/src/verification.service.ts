import { VerificationProjection } from './verification-projection';
import type { DomainEvent } from '@pharma/messaging';
import { VerificationCache } from './verification-cache.store';
import {
  Injectable,
  NotFoundException,
  BadGatewayException,
  Logger,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import {
  normalizeGtin,
  normalizeSerialNumber,
  type VerificationResult,
} from '@pharma/contracts';
import { PrismaService } from './persistence/prisma.service';
import {
  ReferenceClient,
  productSchema,
  gtinSchema,
  batchSchema,
  serialSchema,
  type Identity,
} from './reference.client';
import { parse } from './recall.service';
export const verificationSchema = z
  .object({
    gtin: z.string().transform((s, ctx) => {
      const value = normalizeGtin(s);
      if (!value) {
        ctx.addIssue({ code: 'custom', message: 'Invalid GTIN' });
        return z.NEVER;
      }
      return value;
    }),
    serialNumber: z.string().transform((s, ctx) => {
      const value = normalizeSerialNumber(s);
      if (!value) {
        ctx.addIssue({ code: 'custom', message: 'Invalid serial' });
        return z.NEVER;
      }
      return value;
    }),
  })
  .strict();
@Injectable()
export class VerificationService {
  private readonly logger = new Logger('Verification');
  constructor(
    private readonly db: PrismaService,
    private readonly refs: ReferenceClient,
    @Optional() private readonly cache?: VerificationCache,
    @Optional() private readonly projection?: VerificationProjection,
  ) {}
  async verify(identity: Identity, body: unknown): Promise<VerificationResult> {
    const input = parse(verificationSchema, body);
    const start = Date.now();
    let key: string | undefined;
    try {
      key = await this.cache?.key(
        identity.organizationId,
        input.gtin,
        input.serialNumber,
      );
      const hit = key
        ? await this.cache?.read(key, input.gtin, input.serialNumber)
        : undefined;
      this.logger.log({
        message: 'Verification cache lookup',
        cacheHit: !!hit,
        organizationId: identity.organizationId,
        latencyMs: Date.now() - start,
      });
      if (hit) return hit;
    } catch {
      this.cache?.degraded(identity.organizationId);
      key = undefined;
    }
    let projected: VerificationResult | undefined;
    try {
      projected = await this.projection?.read(
        identity,
        input.gtin,
        input.serialNumber,
      );
    } catch {
      this.logger.warn({
        message: 'Verification projection unavailable',
        fallbackUsed: true,
      });
    }
    const result = projected ?? (await this.authoritative(identity, input));
    this.logger.log({
      message: 'Verification read path',
      projectionHit: !!projected,
      projectionMiss: !projected,
      fallbackUsed: !projected,
    });
    if (key) {
      try {
        await this.cache?.write(key, result);
      } catch {
        this.cache?.degraded(identity.organizationId);
      }
    }
    return result;
  }
  async authoritative(
    identity: Identity,
    input: { gtin: string; serialNumber: string },
    event?: DomainEvent,
    strict = false,
  ): Promise<VerificationResult> {
    const revision = Date.now();
    let generation: string | undefined;
    try {
      if (this.projection?.enabled)
        generation = await this.projection.generation(identity.organizationId);
    } catch (error) {
      if (event || strict) throw error;
    }
    const base = { ...input, verifiedAt: new Date(revision).toISOString() };
    const prefix = `/organizations/${identity.organizationId}`;
    let gtin, serial;
    try {
      gtin = await this.refs.get(
        'PRODUCT',
        `${prefix}/products/identity/${input.gtin}`,
        identity,
        gtinSchema.extend({ product: productSchema }),
      );
      if (
        gtin.gtin !== input.gtin ||
        gtin.product.id !== gtin.productId ||
        gtin.product.organizationId !== identity.organizationId
      )
        throw new BadGatewayException('Invalid GTIN response');
      serial = await this.refs.get(
        'SERIALIZATION',
        `/internal${prefix}/serials/identity/${gtin.id}?${new URLSearchParams({ serialNumber: input.serialNumber })}`,
        identity,
        serialSchema,
      );
    } catch (error) {
      if (error instanceof NotFoundException)
        return {
          ...base,
          result: 'UNKNOWN',
          explanation:
            'No serialized item matches this GTIN and serial number in this organization.',
        };
      throw error;
    }
    if (
      serial.gtinId !== gtin.id ||
      serial.productId !== gtin.productId ||
      serial.serialNumber !== input.serialNumber
    )
      throw new BadGatewayException('Invalid serialized identity response');
    const batch = await this.refs.get(
      'BATCH',
      `${prefix}/batches/${serial.batchId}`,
      identity,
      batchSchema,
    );
    if (
      batch.id !== serial.batchId ||
      batch.productId !== serial.productId ||
      batch.gtinId !== serial.gtinId
    )
      throw new BadGatewayException('Invalid batch response');
    const recall = await this.db.recall.findFirst({
      where: {
        organizationId: identity.organizationId,
        status: 'ACTIVE',
        productId: serial.productId,
        OR: [
          { batchId: serial.batchId },
          { batchId: null, gtinId: serial.gtinId },
          { batchId: null, gtinId: null },
        ],
      },
      orderBy: [{ initiatedAt: 'desc' }, { id: 'asc' }],
    });
    let result: VerificationResult['result'];
    let explanation: string;
    if (recall) {
      result = 'RECALLED';
      explanation =
        'This item is covered by an active recall. Do not distribute or use it.';
    } else if (batch.status === 'RECALLED') {
      result = 'RECALLED';
      explanation = 'The owning Batch service marks this batch as recalled.';
    } else if (serial.status === 'DECOMMISSIONED') {
      result = 'DECOMMISSIONED';
      explanation = 'This serialized item has been decommissioned.';
    } else if (
      serial.status === 'QUARANTINED' ||
      batch.status === 'QUARANTINED'
    ) {
      result = 'QUARANTINED';
      explanation = 'This item or its batch is quarantined.';
    } else if (
      serial.status === 'COMMISSIONED' &&
      batch.status === 'ACTIVE' &&
      gtin.status === 'ACTIVE' &&
      gtin.product.status === 'ACTIVE' &&
      (!batch.expiryDate || batch.expiryDate >= base.verifiedAt.slice(0, 10))
    ) {
      result = 'VALID';
      explanation =
        'Commissioned item with active product, GTIN and batch; no active recall or known expiry.';
    } else {
      result = 'UNKNOWN';
      explanation =
        'The item exists but is not eligible for a valid result. Check commissioning, product, batch and expiry status.';
    }
    this.logger.log({
      message: 'Product verification completed',
      organizationId: identity.organizationId,
      result,
    });
    const response: VerificationResult = {
      ...base,
      result,
      explanation,
      productName: gtin.product.name,
      lotNumber: batch.lotNumber,
      expiryDate: batch.expiryDate,
      ...(recall
        ? {
            recall: {
              recallNumber: recall.recallNumber,
              title: recall.title,
              reason: recall.reason,
              severity: recall.severity,
            },
          }
        : {}),
    };
    if (generation && this.projection) {
      try {
        await this.projection.write(
          identity,
          {
            serializedItemId: serial.id,
            productId: serial.productId,
            batchId: serial.batchId,
            serializationStatus: serial.status,
            gtinId: serial.gtinId,
            productName: gtin.product.name,
            lotNumber: batch.lotNumber,
            expiryDate: batch.expiryDate,
            productStatus: gtin.product.status,
            gtinStatus: gtin.status,
            batchStatus: batch.status,
            activeRecall: !!recall,
            recallId: recall?.id,
            verificationStatus: response.result,
          },
          response,
          revision,
          generation,
          event,
        );
      } catch (error) {
        this.logger.warn({
          message: 'Verification projection repair failed',
          fallbackUsed: true,
        });
        if (event || strict) throw error;
      }
    }
    return response;
  }
}
