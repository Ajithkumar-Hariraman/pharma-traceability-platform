import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { identityPayload } from '@pharma/contracts';
import { z } from 'zod';
const baseRecord = {
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
const organizationResponse = z
  .object({
    ...baseRecord,
    legalName: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .strip();
const facilityResponse = z
  .object({
    ...baseRecord,
    organizationId: z.string().uuid(),
    name: z.string(),
    type: z.enum(['MANUFACTURER', 'DISTRIBUTOR', 'WHOLESALER', 'DISPENSER']),
    gln: z.string().nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .strip();
const membershipResponse = z
  .object({
    ...baseRecord,
    organizationId: z.string().uuid(),
    userId: z.string().uuid(),
    role: z.enum(['ORG_ADMIN', 'OPERATOR', 'VIEWER']),
  })
  .strip();
import { AuthProxyService } from '../auth/auth-proxy.service';
import type { Request } from 'express';
export interface AuthenticatedRequest extends Request {
  userId: string;
}
@Injectable()
export class GatewayIdentityGuard implements CanActivate {
  constructor(private readonly auth: AuthProxyService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.headers.authorization)
      throw new UnauthorizedException('Authentication required');
    const user = await this.auth.forward(
      'me',
      undefined,
      req.headers.authorization,
    );
    if (!('id' in user))
      throw new UnauthorizedException('Authentication required');
    req.userId = user.id;
    return true;
  }
}
@Injectable()
export class OrganizationProxy {
  constructor(private readonly config: ConfigService) {}
  async forward(method: string, path: string, userId: string, body?: unknown) {
    const base = this.config.get<string>('ORGANIZATION_SERVICE_URL');
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException(
        'Organization Service is unavailable',
      );
    const timestamp = String(Date.now());
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const signature = createHmac('sha256', secret)
      .update(identityPayload(method, path, timestamp, userId, raw))
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
          'x-identity-time': timestamp,
          'x-identity-signature': signature,
        },
        ...(method === 'GET' ? {} : { body: raw }),
      });
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException(
          'Organization Service request timed out',
        );
      throw new ServiceUnavailableException(
        'Organization Service is unavailable',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Invalid organization or facility input',
        401: 'Authentication required',
        403: 'Organization access or administrator permission required',
        404: 'Organization or facility not found',
        409: 'This GLN is already assigned to a facility',
      };
      const message = messages[response.status];
      if (message) throw new HttpException(message, response.status);
      throw new BadGatewayException(
        'Organization Service returned an invalid response',
      );
    }
    try {
      const schema = path.endsWith('/access')
        ? z
            .object({
              organizationId: z.string().uuid(),
              userId: z.string().uuid(),
              role: z.enum(['ORG_ADMIN', 'OPERATOR', 'VIEWER']),
            })
            .strip()
        : path.endsWith('/memberships')
          ? membershipResponse.array()
          : path.includes('/facilities')
            ? method === 'GET' && path.endsWith('/facilities')
              ? facilityResponse.array()
              : facilityResponse
            : method === 'GET' && path === '/organizations'
              ? organizationResponse.array()
              : organizationResponse;
      return schema.parse(await response.json());
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException(
          'Organization Service request timed out',
        );
      throw new BadGatewayException(
        'Organization Service returned an invalid response',
      );
    }
  }
}
