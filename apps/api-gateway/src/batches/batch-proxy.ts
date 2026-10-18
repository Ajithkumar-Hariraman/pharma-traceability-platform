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
  batchStatuses,
} from '@pharma/contracts';
import { OrganizationProxy } from '../organizations/organization-proxy';
const batchResponse = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    productId: z.string().uuid(),
    gtinId: z.string().uuid(),
    lotNumber: z.string(),
    manufactureDate: z.iso.date().nullable(),
    expiryDate: z.iso.date().nullable(),
    status: z.enum(batchStatuses),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strip();
@Injectable()
export class BatchProxy {
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
    if (method !== 'GET' && !canWriteOrganizationResource(access.role, 'batch'))
      throw new HttpException('Organization write permission required', 403);
    const base = this.config.get<string>('BATCH_SERVICE_URL');
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException('Batch Service is unavailable');
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
        throw new GatewayTimeoutException('Batch Service request timed out');
      throw new ServiceUnavailableException('Batch Service is unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Invalid batch input. Check lot number, dates and status',
        401: 'Authentication required',
        403: 'Organization access or administrator permission required',
        404: 'Batch, product or GTIN not found',
        409: 'Lot number already exists for this GTIN',
        503: 'Product validation is unavailable',
        504: 'Product validation timed out',
      };
      const message = messages[response.status];
      if (message) throw new HttpException(message, response.status);
      throw new BadGatewayException(
        'Batch Service returned an invalid response',
      );
    }
    try {
      const schema =
        method === 'GET' && path.endsWith('/batches')
          ? batchResponse.array()
          : batchResponse;
      const data = schema.parse(await response.json());
      const rows = Array.isArray(data) ? data : [data];
      const parts = path.split('/');
      if (
        rows.some(
          (row) =>
            row.organizationId !== organizationId ||
            (parts[3] === 'products' &&
              (row.productId !== parts[4] || row.gtinId !== parts[6])) ||
            (parts[3] === 'batches' && parts[4] && row.id !== parts[4]),
        )
      )
        throw new Error('Invalid batch ownership');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Batch Service request timed out');
      throw new BadGatewayException(
        'Batch Service returned an invalid response',
      );
    }
  }
}
