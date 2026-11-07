import {
  Injectable,
  UnauthorizedException,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { productIdentityPayload, traceCapturePayload } from '@pharma/contracts';
import { z } from 'zod';
export interface TraceRequest {
  method: string;
  originalUrl: string;
  rawBody?: Buffer;
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
  caller: string;
}
@Injectable()
export class TraceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const r = context.switchToHttp().getRequest<TraceRequest>();
    const h = r.headers;
    const org = h['x-identity-organization'];
    const time = h['x-identity-time'];
    const sig = h['x-identity-signature'];
    const capture =
      r.method === 'POST' && r.originalUrl.startsWith('/internal/');
    if (
      !org ||
      org !== r.params.organizationId ||
      !z.string().uuid().safeParse(org).success ||
      !time ||
      !/^\d{13}$/.test(time) ||
      Math.abs(Date.now() - Number(time)) > 30000 ||
      !sig ||
      !/^[a-f0-9]{64}$/.test(sig)
    )
      throw new UnauthorizedException('Invalid internal identity');
    let payload: string;
    let secret: string;
    if (capture) {
      const caller = h['x-trace-caller'];
      if (
        caller !== 'serialization-service' &&
        caller !== 'aggregation-service'
      )
        throw new UnauthorizedException('Untrusted capture caller');
      r.caller = caller;
      payload = traceCapturePayload(
        r.method,
        r.originalUrl,
        time,
        caller,
        org,
        r.rawBody?.toString('utf8') ?? '',
      );
      secret = this.config.getOrThrow<string>('TRACE_CAPTURE_SECRET');
    } else {
      const user = h['x-identity-user'];
      const role = h['x-identity-role'];
      if (
        r.method !== 'GET' ||
        !user ||
        !z.string().uuid().safeParse(user).success ||
        !['ORG_ADMIN', 'OPERATOR', 'VIEWER'].includes(role ?? '')
      )
        throw new UnauthorizedException('Invalid read identity');
      payload = productIdentityPayload(
        r.method,
        r.originalUrl,
        time,
        user,
        '',
        org,
        role as import('@pharma/contracts').OrganizationRole,
      );
      secret = this.config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET');
    }
    if (
      !timingSafeEqual(
        createHmac('sha256', secret).update(payload).digest(),
        Buffer.from(sig, 'hex'),
      )
    )
      throw new UnauthorizedException('Invalid internal signature');
    return true;
  }
}
