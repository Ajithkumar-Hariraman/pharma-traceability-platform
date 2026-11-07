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
  shipmentStatuses,
  type OrganizationRole,
} from '@pharma/contracts';
import { OrganizationProxy } from '../organizations/organization-proxy';
@Injectable()
export class ShipmentProxy {
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
      !canWriteOrganizationResource(access.role, 'shipment')
    )
      throw new HttpException('Organization write permission required', 403);
    const base = this.config.get<string>('SHIPMENT_SERVICE_URL');
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException('Shipment Service is unavailable');
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
      this.config.getOrThrow<number>('SHIPMENT_SERVICE_TIMEOUT_MS'),
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
        throw new GatewayTimeoutException('Shipment Service request timed out');
      throw new ServiceUnavailableException('Shipment Service is unavailable');
    }
    if (!response.ok) {
      let failure: unknown;
      try {
        failure = await response.json();
      } catch {
        failure = null;
      }
      const reconciliation = z
        .object({
          code: z.literal('TRACE_CAPTURE_FAILED'),
          businessStateChanged: z.literal(true),
          message: z.string(),
          event: z
            .object({
              organizationId: z.literal(organizationId),
              eventType: z.literal('TRANSACTION'),
            })
            .passthrough(),
        })
        .safeParse(failure);
      if (response.status === 503 && reconciliation.success)
        throw new HttpException(reconciliation.data, 503);
      const messages: Record<number, string> = {
        400: 'Invalid shipment input or filters',
        401: 'Authentication required',
        403: 'Organization write permission required',
        404: 'Shipment or reference not found',
        409: 'Duplicate shipment content or number, ineligible reference, or invalid lifecycle transition',
        503: 'Shipment reference validation unavailable',
        504: 'Shipment reference validation timed out',
      };
      throw new HttpException(
        messages[response.status] ??
          'Shipment Service returned an invalid response',
        messages[response.status] ? response.status : 502,
      );
    }
    try {
      const shipment = z
        .object({
          id: z.string().uuid(),
          organizationId: z.literal(organizationId),
          shipmentNumber: z.string(),
          sourceFacilityId: z.string().uuid(),
          destinationFacilityId: z.string().uuid(),
          status: z.enum(shipmentStatuses),
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
        })
        .passthrough();
      const pathname = path.split('?')[0]!;
      const schema =
        method === 'DELETE'
          ? z.object({ removed: z.literal(true) })
          : method === 'GET' && pathname.endsWith('/shipments')
            ? z.object({
                items: shipment.array(),
                total: z.number().int().nonnegative(),
                page: z.number().int().positive(),
                pageSize: z.number().int().max(100),
              })
            : method === 'POST' && /\/(items|containers)$/.test(pathname)
              ? z.object({
                  id: z.string().uuid(),
                  organizationId: z.literal(organizationId),
                  shipmentId: z.string().uuid(),
                  kind: z.enum(['items', 'containers']),
                  referenceId: z.string().uuid(),
                })
              : shipment;
      const data = schema.parse(await response.json());
      const id = pathname.split('/')[4];
      if (
        id &&
        'id' in data &&
        ('shipmentId' in data ? data.shipmentId !== id : data.id !== id)
      )
        throw new Error();
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Shipment Service request timed out');
      throw new BadGatewayException(
        'Shipment Service returned an invalid response',
      );
    }
  }
}
