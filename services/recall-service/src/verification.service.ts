import {
  Injectable,
  NotFoundException,
  BadGatewayException,
  Logger,
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
  ) {}
  async verify(identity: Identity, body: unknown): Promise<VerificationResult> {
    const input = parse(verificationSchema, body);
    const base = { ...input, verifiedAt: new Date().toISOString() };
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
    return {
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
  }
}
