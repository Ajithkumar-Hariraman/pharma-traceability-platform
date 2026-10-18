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
} from '@pharma/contracts';
import { z } from 'zod';
const reference = z
  .object({
    organizationId: z.string().uuid(),
    productId: z.string().uuid(),
    gtinId: z.string().uuid(),
  })
  .strict();
@Injectable()
export class ProductValidationClient {
  constructor(private readonly config: ConfigService) {}
  async validate(
    organizationId: string,
    productId: string,
    gtinId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<void> {
    const path = `/internal/organizations/${organizationId}/products/${productId}/gtins/${gtinId}/validation`;
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
      this.config.getOrThrow<number>('PRODUCT_SERVICE_TIMEOUT_MS'),
    );
    let response: Response;
    try {
      response = await fetch(
        `${this.config.getOrThrow<string>('PRODUCT_SERVICE_URL')}${path}`,
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
        throw new GatewayTimeoutException('Product validation timed out');
      throw new ServiceUnavailableException(
        'Product validation is unavailable',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        throw new NotFoundException(
          'Product or GTIN not found in this organization and product',
        );
      throw new ServiceUnavailableException(
        'Product validation is unavailable',
      );
    }
    try {
      const data = reference.parse(await response.json());
      if (
        data.organizationId !== organizationId ||
        data.productId !== productId ||
        data.gtinId !== gtinId
      )
        throw new Error('Reference mismatch');
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Product validation timed out');
      throw new BadGatewayException('Invalid Product validation response');
    }
  }
}
