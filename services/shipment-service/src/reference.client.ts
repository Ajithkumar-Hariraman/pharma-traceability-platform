import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  GatewayTimeoutException,
  BadGatewayException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  identityPayload,
  productIdentityPayload,
  type OrganizationRole,
} from '@pharma/contracts';
import { z } from 'zod';
@Injectable()
export class ReferenceClient {
  constructor(private readonly config: ConfigService) {}
  async validate(
    org: string,
    id: string,
    kind: 'facilities' | 'items' | 'containers',
    user: string,
    role: OrganizationRole,
  ) {
    const facility = kind === 'facilities';
    const service = facility
      ? 'ORGANIZATION'
      : kind === 'items'
        ? 'SERIALIZATION'
        : 'AGGREGATION';
    const path = facility
      ? `/organizations/${org}/facilities/${id}`
      : kind === 'items'
        ? `/internal/organizations/${org}/serials/${id}/validation`
        : `/organizations/${org}/aggregates/${id}`;
    const time = String(Date.now());
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    )
      .update(
        facility
          ? identityPayload('GET', path, time, user, '')
          : productIdentityPayload('GET', path, time, user, '', org, role),
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
          redirect: 'error',
          signal,
          headers: {
            'x-identity-user': user,
            'x-identity-organization': org,
            'x-identity-role': role,
            'x-identity-time': time,
            'x-identity-signature': signature,
          },
        },
      );
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Reference validation timed out');
      throw new ServiceUnavailableException('Reference validation unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        throw new NotFoundException('Reference not found in this organization');
      throw new ServiceUnavailableException('Reference validation unavailable');
    }
    let data;
    try {
      data = z
        .object({
          id: z.string().uuid(),
          organizationId: z.string().uuid(),
          status: z.string().optional(),
        })
        .parse(await response.json());
      if (data.id !== id || data.organizationId !== org) throw new Error();
    } catch {
      throw new BadGatewayException('Invalid reference validation response');
    }
    if (
      !facility &&
      (kind === 'items'
        ? data.status !== 'COMMISSIONED'
        : data.status !== 'ACTIVE')
    )
      throw new ConflictException('Reference is not eligible for shipping');
    return data;
  }
}
