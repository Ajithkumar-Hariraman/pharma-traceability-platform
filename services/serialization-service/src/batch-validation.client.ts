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
  type BatchReference,
  batchStatuses,
} from '@pharma/contracts';
import { z } from 'zod';
const reference = z
  .object({
    organizationId: z.string().uuid(),
    productId: z.string().uuid(),
    gtinId: z.string().uuid(),
    batchId: z.string().uuid(),
    status: z.enum(batchStatuses),
  })
  .strict();
@Injectable()
export class BatchValidationClient {
  constructor(private readonly config: ConfigService) {}
  async validate(
    organizationId: string,
    batchId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<BatchReference> {
    const path = `/internal/organizations/${organizationId}/batches/${batchId}/validation`;
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
      this.config.getOrThrow<number>('BATCH_SERVICE_TIMEOUT_MS'),
    );
    let response: Response;
    try {
      response = await fetch(
        `${this.config.getOrThrow<string>('BATCH_SERVICE_URL')}${path}`,
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
        throw new GatewayTimeoutException('Batch validation timed out');
      throw new ServiceUnavailableException('Batch validation is unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        throw new NotFoundException('Batch not found in this organization');
      throw new ServiceUnavailableException('Batch validation is unavailable');
    }
    try {
      const data = reference.parse(await response.json());
      if (data.organizationId !== organizationId || data.batchId !== batchId)
        throw new Error('Reference mismatch');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Batch validation timed out');
      throw new BadGatewayException('Invalid Batch validation response');
    }
  }
}
