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
  serializedItemStatuses,
} from '@pharma/contracts';
import { OrganizationProxy } from '../organizations/organization-proxy';
const container = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    containerCode: z.string(),
    packagingLevel: z.enum(['INNER', 'CASE', 'PALLET']),
    status: z.enum(['ACTIVE', 'CLOSED', 'DECOMMISSIONED']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
const serial = z.object({
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
});
function validateHierarchy(
  value: unknown,
  organizationId: string,
  depth = 0,
): void {
  if (depth > 2) throw new Error('Invalid hierarchy depth');
  const node = container
    .extend({ children: z.array(z.unknown()), items: serial.array() })
    .parse(value);
  if (
    node.organizationId !== organizationId ||
    node.items.some((item) => item.organizationId !== organizationId)
  )
    throw new Error('Invalid hierarchy ownership');
  node.children.forEach((child) =>
    validateHierarchy(child, organizationId, depth + 1),
  );
}
@Injectable()
export class AggregationProxy {
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
      !canWriteOrganizationResource(access.role, 'aggregation')
    )
      throw new HttpException('Organization write permission required', 403);
    const base = this.config.get<string>('AGGREGATION_SERVICE_URL');
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException(
        'Aggregation Service is unavailable',
      );
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
        throw new GatewayTimeoutException(
          'Aggregation Service request timed out',
        );
      throw new ServiceUnavailableException(
        'Aggregation Service is unavailable',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Invalid container or child input',
        401: 'Authentication required',
        403: 'Organization write permission required',
        404: 'Container, relationship or serialized item not found',
        409: 'Duplicate code, child already parented, invalid hierarchy or inactive lifecycle',
        503: 'Serialization validation is unavailable',
        504: 'Serialization validation timed out',
      };
      const message = messages[response.status];
      if (message) throw new HttpException(message, response.status);
      throw new BadGatewayException(
        'Aggregation Service returned an invalid response',
      );
    }
    try {
      const schema =
        method === 'DELETE'
          ? z.object({ removed: z.literal(true) })
          : path.endsWith('/parent')
            ? container.nullable()
            : method === 'GET' && path.endsWith('/aggregates')
              ? container.array()
              : method === 'POST' && /\/(items|containers)$/.test(path)
                ? z
                    .object({
                      id: z.string().uuid(),
                      organizationId: z.string().uuid(),
                      parentContainerId: z.string().uuid(),
                    })
                    .passthrough()
                : container;
      const data = schema.parse(await response.json());
      const rows = Array.isArray(data)
        ? data
        : data && 'organizationId' in data
          ? [data]
          : [];
      if (rows.some((row) => row.organizationId !== organizationId))
        throw new Error('Invalid ownership');
      if (path.endsWith('/hierarchy')) validateHierarchy(data, organizationId);
      const parts = path.split('/');
      if (
        data &&
        !Array.isArray(data) &&
        'id' in data &&
        parts[3] === 'aggregates' &&
        parts[4] &&
        !/\/(items|containers)$/.test(path) &&
        data.id !== parts[4]
      )
        throw new Error('Invalid container identity');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException(
          'Aggregation Service request timed out',
        );
      throw new BadGatewayException(
        'Aggregation Service returned an invalid response',
      );
    }
  }
}
