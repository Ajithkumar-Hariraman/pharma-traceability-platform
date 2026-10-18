import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { identityPayload } from '@pharma/contracts';
import { z } from 'zod';
import { OrganizationRepository } from './organization.repository';
export interface InternalRequest {
  method: string;
  originalUrl: string;
  body?: unknown;
  rawBody?: Buffer;
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
  userId: string;
}
export const AdminOnly = () => SetMetadata('organization-admin', true);
@Injectable()
export class InternalIdentityGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<InternalRequest>();
    const id = request.headers['x-identity-user'];
    const timestamp = request.headers['x-identity-time'];
    const signature = request.headers['x-identity-signature'];
    if (
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
        identityPayload(
          request.method,
          request.originalUrl,
          timestamp,
          id,
          request.rawBody?.toString('utf8') ?? '',
        ),
      )
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
      throw new UnauthorizedException('Invalid internal identity');
    request.userId = id;
    return true;
  }
}
@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<InternalRequest>();
    const id = req.params.organizationId;
    if (!id) return true;
    if (!z.string().uuid().safeParse(id).success)
      throw new BadRequestException('Invalid organization ID');
    if (!(await this.repository.find(id)))
      throw new NotFoundException('Organization not found');
    const role = await this.repository.role(id, req.userId);
    if (!role) throw new ForbiddenException('Organization access denied');
    if (
      this.reflector.get<boolean>('organization-admin', context.getHandler()) &&
      role !== 'ORG_ADMIN'
    )
      throw new ForbiddenException(
        'Organization administrator permission required',
      );
    return true;
  }
}
