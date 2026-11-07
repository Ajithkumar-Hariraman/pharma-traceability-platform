import {
  Injectable,
  ServiceUnavailableException,
  BadGatewayException,
  HttpException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  productIdentityPayload,
  traceEventTypes,
  traceActions,
  type OrganizationRole,
} from '@pharma/contracts';
import { z } from 'zod';
import { OrganizationProxy } from '../organizations/organization-proxy';
const eventSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string(),
    organizationId: z.string().uuid(),
    eventType: z.enum(traceEventTypes),
    action: z.enum(traceActions),
    eventTime: z.iso.datetime(),
    recordTime: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    serializedItemId: z.string().uuid().nullable(),
    batchId: z.string().uuid().nullable(),
    aggregateContainerId: z.string().uuid().nullable(),
    childContainerId: z.string().uuid().nullable(),
    facilityId: z.string().uuid().nullable(),
    productId: z.string().uuid().nullable(),
    gtinId: z.string().uuid().nullable(),
    parentEventId: z.string().uuid().nullable(),
    businessStep: z.string().nullable(),
    disposition: z.string().nullable(),
    metadata: z.record(z.string(), z.json()).nullable(),
  })
  .strip();
@Injectable()
export class TraceProxy {
  constructor(
    private readonly config: ConfigService,
    private readonly organizations: OrganizationProxy,
  ) {}
  async forward(path: string, userId: string) {
    const org = path.split('/')[2]!;
    const access = (await this.organizations.forward(
      'GET',
      `/organizations/${org}/access`,
      userId,
    )) as { organizationId: string; userId: string; role: OrganizationRole };
    if (
      access.organizationId !== org ||
      access.userId !== userId ||
      !['ORG_ADMIN', 'OPERATOR', 'VIEWER'].includes(access.role)
    )
      throw new BadGatewayException('Invalid authorization context');
    const base = this.config.get<string>('TRACEABILITY_SERVICE_URL');
    if (!base)
      throw new ServiceUnavailableException(
        'Traceability Service is unavailable',
      );
    const time = String(Date.now());
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    )
      .update(
        productIdentityPayload('GET', path, time, userId, '', org, access.role),
      )
      .digest('hex');
    const signal = AbortSignal.timeout(
      this.config.getOrThrow<number>('AUTH_SERVICE_TIMEOUT_MS'),
    );
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        signal,
        redirect: 'error',
        headers: {
          'x-identity-user': userId,
          'x-identity-role': access.role,
          'x-identity-organization': org,
          'x-identity-time': time,
          'x-identity-signature': signature,
        },
      });
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Traceability request timed out');
      throw new ServiceUnavailableException(
        'Traceability Service is unavailable',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404].includes(response.status))
        throw new HttpException('Trace query rejected', response.status);
      throw new BadGatewayException('Traceability request failed');
    }
    try {
      const detail = path.split('?')[0]!.includes('/events/');
      const data = (
        detail
          ? eventSchema
          : z.object({
              items: eventSchema.array().max(100),
              page: z.number().int().positive(),
              pageSize: z.number().int().min(1).max(100),
              total: z.number().int().nonnegative(),
            })
      ).parse(await response.json());
      const rows = 'items' in data ? data.items : [data];
      const parts = path.split('?')[0]!.split('/');
      const resource = parts[4],
        reference = parts[5];
      if (
        rows.some(
          (row) =>
            (resource === 'serials' && row.serializedItemId !== reference) ||
            (resource === 'batches' && row.batchId !== reference) ||
            (resource === 'aggregates' &&
              row.aggregateContainerId !== reference &&
              row.childContainerId !== reference) ||
            (resource === 'events' &&
              reference &&
              row.eventId !== decodeURIComponent(reference)),
        )
      )
        throw new Error('Trace scope mismatch');
      if ('items' in data && data.items.length > data.pageSize)
        throw new Error('Invalid page size');
      if (
        !Array.isArray(rows) ||
        rows.some((row) => row.organizationId !== org)
      )
        throw new Error('Ownership mismatch');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Traceability request timed out');
      throw new BadGatewayException('Invalid trace response');
    }
  }
}
