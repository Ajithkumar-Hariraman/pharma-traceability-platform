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
  canExecuteSerialCommand,
} from '@pharma/contracts';
import { OrganizationProxy } from '../organizations/organization-proxy';
const serialResponse = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    productId: z.string().uuid(),
    gtinId: z.string().uuid(),
    batchId: z.string().uuid(),
    serialNumber: z.string(),
    commissionedAt: z.string().datetime().nullable(),
    decommissionedAt: z.string().datetime().nullable(),
    status: z.enum(serializedItemStatuses),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strip();
@Injectable()
export class SerializationProxy {
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
      !canWriteOrganizationResource(access.role, 'serialization')
    )
      throw new HttpException('Organization write permission required', 403);
    const command = path.split('/').at(-1);
    if (
      (command === 'commission' ||
        command === 'decommission' ||
        command === 'quarantine') &&
      !canExecuteSerialCommand(access.role, command)
    )
      throw new HttpException('Serial command permission required', 403);
    const base = this.config.get<string>('SERIALIZATION_SERVICE_URL');
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException(
        'Serialization Service is unavailable',
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
          'Serialization Service request timed out',
        );
      throw new ServiceUnavailableException(
        'Serialization Service is unavailable',
      );
    }
    if (!response.ok) {
      if (response.status === 503) {
        const failure = (await response.json().catch(() => null)) as {
          code?: string;
          businessStateChanged?: boolean;
          event?: unknown;
        } | null;
        if (
          failure?.code === 'TRACE_CAPTURE_FAILED' &&
          failure.businessStateChanged === true
        )
          throw new HttpException(failure, 503);
        throw new HttpException('Serialization dependency is unavailable', 503);
      }
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Invalid serial input or immutable metadata',
        401: 'Authentication required',
        403: 'Organization access or administrator permission required',
        404: 'Batch or serialized item not found',
        409: 'Duplicate serial, unusable batch or invalid lifecycle transition',
        503: 'Batch validation is unavailable',
        504: 'Batch validation timed out',
      };
      const message = messages[response.status];
      if (message) throw new HttpException(message, response.status);
      throw new BadGatewayException(
        'Serialization Service returned an invalid response',
      );
    }
    try {
      const schema =
        (method === 'GET' && path.endsWith('/serials')) ||
        path.endsWith('/bulk')
          ? serialResponse.array()
          : serialResponse;
      const data = schema.parse(await response.json());
      const rows = Array.isArray(data) ? data : [data];
      const parts = path.split('/');
      if (
        rows.some(
          (row) =>
            row.organizationId !== organizationId ||
            (parts[3] === 'batches' && row.batchId !== parts[4]) ||
            (parts[3] === 'serials' && row.id !== parts[4]),
        )
      )
        throw new Error('Invalid serialized item ownership');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException(
          'Serialization Service request timed out',
        );
      throw new BadGatewayException(
        'Serialization Service returned an invalid response',
      );
    }
  }
}
