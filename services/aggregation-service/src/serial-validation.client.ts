import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  GatewayTimeoutException,
  BadGatewayException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  productIdentityPayload,
  type OrganizationRole,
  type SerializedItem,
  serializedItemStatuses,
} from '@pharma/contracts';
import { z } from 'zod';
const reference = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    productId: z.string().uuid(),
    gtinId: z.string().uuid(),
    batchId: z.string().uuid(),
    serialNumber: z.string(),
    status: z.enum(serializedItemStatuses),
    commissionedAt: z.string().datetime().nullable(),
    decommissionedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
@Injectable()
export class SerialValidationClient {
  constructor(private readonly config: ConfigService) {}
  async validate(
    organizationId: string,
    serialId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<SerializedItem> {
    const path = `/internal/organizations/${organizationId}/serials/${serialId}/validation`;
    const timestamp = String(Date.now());
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    )
      .update(
        productIdentityPayload(
          'GET',
          path,
          timestamp,
          userId,
          '',
          organizationId,
          role,
        ),
      )
      .digest('hex');
    const signal = AbortSignal.timeout(
      this.config.getOrThrow<number>('SERIALIZATION_SERVICE_TIMEOUT_MS'),
    );
    let response: Response;
    try {
      response = await fetch(
        `${this.config.getOrThrow<string>('SERIALIZATION_SERVICE_URL')}${path}`,
        {
          signal,
          redirect: 'error',
          headers: {
            'x-identity-user': userId,
            'x-identity-organization': organizationId,
            'x-identity-role': role,
            'x-identity-time': timestamp,
            'x-identity-signature': signature,
          },
        },
      );
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Serialization validation timed out');
      throw new ServiceUnavailableException(
        'Serialization validation is unavailable',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        throw new NotFoundException(
          'Serialization not found in this organization',
        );
      throw new ServiceUnavailableException(
        'Serialization validation is unavailable',
      );
    }
    try {
      const data = reference.parse(await response.json());
      if (data.organizationId !== organizationId || data.id !== serialId)
        throw new Error('Reference mismatch');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Serialization validation timed out');
      throw new BadGatewayException(
        'Invalid Serialization validation response',
      );
    }
  }
}
