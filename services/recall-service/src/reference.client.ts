import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  BadGatewayException,
  GatewayTimeoutException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  productIdentityPayload,
  type OrganizationRole,
  serializedItemStatuses,
  batchStatuses,
} from '@pharma/contracts';
import { z } from 'zod';
const id = z.string().uuid();
export const productSchema = z.object({
  id,
  organizationId: id,
  name: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export const gtinSchema = z.object({
  id,
  organizationId: id,
  productId: id,
  gtin: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export const batchSchema = z.object({
  id,
  organizationId: id,
  productId: id,
  gtinId: id,
  lotNumber: z.string(),
  expiryDate: z.iso.date().nullable(),
  status: z.enum(batchStatuses),
});
export const serialSchema = z.object({
  id,
  organizationId: id,
  productId: id,
  gtinId: id,
  batchId: id,
  serialNumber: z.string(),
  status: z.enum(serializedItemStatuses),
});
export interface Identity {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}
export interface Scope {
  productId: string;
  gtinId?: string | null;
  batchId?: string | null;
}
@Injectable()
export class ReferenceClient {
  constructor(private readonly config: ConfigService) {}
  async get<T>(
    service: string,
    path: string,
    identity: Identity,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const time = String(Date.now());
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    )
      .update(
        productIdentityPayload(
          'GET',
          path,
          time,
          identity.userId,
          '',
          identity.organizationId,
          identity.role,
        ),
      )
      .digest('hex');
    const signal = AbortSignal.timeout(
      this.config.getOrThrow<number>('REFERENCE_TIMEOUT_MS'),
    );
    let response: Response;
    try {
      response = await fetch(
        `${this.config.getOrThrow<string>(`${service}_SERVICE_URL`)}${path}`,
        {
          signal,
          redirect: 'error',
          headers: {
            'x-identity-user': identity.userId,
            'x-identity-organization': identity.organizationId,
            'x-identity-role': identity.role,
            'x-identity-time': time,
            'x-identity-signature': signature,
          },
        },
      );
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Reference request timed out');
      throw new ServiceUnavailableException('Reference service unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        throw new NotFoundException('Reference not found in this organization');
      throw new ServiceUnavailableException('Reference service unavailable');
    }
    try {
      const data = schema.parse(await response.json());
      if (
        !data ||
        typeof data !== 'object' ||
        !('organizationId' in data) ||
        data.organizationId !== identity.organizationId
      )
        throw new Error();
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Reference request timed out');
      throw new BadGatewayException('Invalid reference response');
    }
  }
  async scope(scope: Scope, identity: Identity) {
    const prefix = `/organizations/${identity.organizationId}`;
    const product = await this.get(
      'PRODUCT',
      `${prefix}/products/${scope.productId}`,
      identity,
      productSchema,
    );
    if (product.id !== scope.productId)
      throw new BadGatewayException('Invalid product reference');
    if (scope.gtinId) {
      const gtin = await this.get(
        'PRODUCT',
        `${prefix}/products/${scope.productId}/gtins/${scope.gtinId}`,
        identity,
        gtinSchema,
      );
      if (gtin.id !== scope.gtinId || gtin.productId !== scope.productId)
        throw new ConflictException('Inconsistent GTIN scope');
    }
    if (scope.batchId) {
      const batch = await this.get(
        'BATCH',
        `${prefix}/batches/${scope.batchId}`,
        identity,
        batchSchema,
      );
      if (
        batch.id !== scope.batchId ||
        batch.productId !== scope.productId ||
        (scope.gtinId && batch.gtinId !== scope.gtinId)
      )
        throw new ConflictException('Inconsistent batch scope');
    }
  }
}
