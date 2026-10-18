import {
  Injectable,
  ServiceUnavailableException,
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

import { z } from 'zod';
import {
  productIdentityPayload,
  canWriteOrganizationResource,
  type OrganizationRole,
  packagingLevels,
} from '@pharma/contracts';
import { OrganizationProxy } from '../organizations/organization-proxy';
const baseRecord = {
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
};
const productResponse = z
  .object({
    ...baseRecord,
    name: z.string(),
    description: z.string().nullable(),
    manufacturerName: z.string().nullable(),
  })
  .strip();
const gtinResponse = z
  .object({
    ...baseRecord,
    productId: z.string().uuid(),
    gtin: z.string().regex(/^\d{14}$/),
    packagingLevel: z.enum(packagingLevels),
  })
  .strip();
@Injectable()
export class ProductProxy {
  constructor(
    private readonly config: ConfigService,
    private readonly organizations: OrganizationProxy,
  ) {}
  async forward(method: string, path: string, userId: string, body?: unknown) {
    const organizationId = path.split('/')[2]!;
    const access = (await this.organizations.forward(
      'GET',
      `/organizations/${organizationId}/access`,
      userId,
    )) as { organizationId: string; userId: string; role: OrganizationRole };
    if (access.organizationId !== organizationId || access.userId !== userId)
      throw new BadGatewayException('Invalid authorization context');
    if (
      method !== 'GET' &&
      !canWriteOrganizationResource(access.role, 'product')
    )
      throw new HttpException(
        'Organization administrator permission required',
        403,
      );
    const base = this.config.get<string>('PRODUCT_SERVICE_URL');
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException('Product Service is unavailable');
    const timestamp = String(Date.now());
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const signature = createHmac('sha256', secret)
      .update(
        productIdentityPayload(
          method,
          path,
          timestamp,
          userId,
          raw,
          organizationId,
          access.role,
        ),
      )
      .digest('hex');
    const signal = AbortSignal.timeout(
      this.config.getOrThrow<number>('AUTH_SERVICE_TIMEOUT_MS'),
    );
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        signal,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'x-identity-user': userId,
          'x-identity-organization': organizationId,
          'x-identity-role': access.role,
          'x-identity-time': timestamp,
          'x-identity-signature': signature,
        },
        ...(method === 'GET' ? {} : { body: raw }),
      });
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Product Service request timed out');
      throw new ServiceUnavailableException('Product Service is unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Invalid product or GTIN input. Check GTIN length, GS1 check digit, packaging level and status',
        401: 'Authentication required',
        403: 'Organization access or administrator permission required',
        404: 'Product or GTIN not found',
        409: 'GTIN is already assigned',
      };
      const message = messages[response.status];
      if (message) throw new HttpException(message, response.status);
      throw new BadGatewayException(
        'Product Service returned an invalid response',
      );
    }
    try {
      const item = path.includes('/gtins') ? gtinResponse : productResponse;
      const schema =
        method === 'GET' &&
        (path.endsWith('/products') || path.endsWith('/gtins'))
          ? item.array()
          : item;
      const data = schema.parse(await response.json());
      const rows = Array.isArray(data) ? data : [data];
      const productId = path.split('/')[4];
      if (
        rows.some(
          (row) =>
            row.organizationId !== organizationId ||
            ('productId' in row && row.productId !== productId),
        )
      )
        throw new Error('Invalid ownership');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Product Service request timed out');
      throw new BadGatewayException(
        'Product Service returned an invalid response',
      );
    }
  }
}
