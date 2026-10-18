import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  productIdentityPayload,
  canWriteOrganizationResource,
  canExecuteSerialCommand,
} from '@pharma/contracts';
import { z } from 'zod';

export interface InternalRequest {
  method: string;
  originalUrl: string;
  body?: unknown;
  rawBody?: Buffer;
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
  userId: string;
  organizationId: string;
  role: import('@pharma/contracts').OrganizationRole;
}

@Injectable()
export class InternalIdentityGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<InternalRequest>();
    const id = request.headers['x-identity-user'];
    const timestamp = request.headers['x-identity-time'];
    const signature = request.headers['x-identity-signature'];
    const organizationId = request.headers['x-identity-organization'];
    const role = request.headers['x-identity-role'];
    if (
      !organizationId ||
      organizationId !== request.params.organizationId ||
      !z.string().uuid().safeParse(organizationId).success ||
      (role !== 'ORG_ADMIN' && role !== 'OPERATOR' && role !== 'VIEWER') ||
      !id ||
      !z.string().uuid().safeParse(id).success ||
      !timestamp ||
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp)) > 30000 ||
      !signature ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw new UnauthorizedException('Invalid internal identity');
    const expected = createHmac(
      'sha256',
      this.config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    )
      .update(
        productIdentityPayload(
          request.method,
          request.originalUrl,
          timestamp,
          id,
          request.rawBody?.toString('utf8') ?? '',
          organizationId,
          role,
        ),
      )
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
      throw new UnauthorizedException('Invalid internal identity');
    if (
      request.method !== 'GET' &&
      !canWriteOrganizationResource(role, 'serialization')
    )
      throw new ForbiddenException('Organization write permission required');
    const command = request.originalUrl.split('/').at(-1);
    if (
      (command === 'commission' ||
        command === 'decommission' ||
        command === 'quarantine') &&
      !canExecuteSerialCommand(role, command)
    )
      throw new ForbiddenException('Serial command permission required');
    request.role = role;
    request.organizationId = organizationId;
    request.userId = id;
    return true;
  }
}
