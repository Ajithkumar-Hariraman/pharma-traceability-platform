import {
  Injectable,
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  recallStatuses,
  recallSeverities,
  verificationResults,
  productIdentityPayload,
  canWriteOrganizationResource,
  type OrganizationRole,
} from '@pharma/contracts';
import { OrganizationProxy } from '../organizations/organization-proxy';
const id = z.string().uuid();
const recallSchema = z.object({
  id,
  organizationId: id,
  recallNumber: z.string(),
  title: z.string(),
  reason: z.string(),
  severity: z.enum(recallSeverities),
  status: z.enum(recallStatuses),
  productId: id,
  gtinId: id.nullable(),
  batchId: id.nullable(),
  createdBy: id,
  initiatedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const verificationSchema = z.object({
  result: z.enum(verificationResults),
  gtin: z.string(),
  serialNumber: z.string(),
  verifiedAt: z.iso.datetime(),
  explanation: z.string(),
  productName: z.string().optional(),
  lotNumber: z.string().optional(),
  expiryDate: z.iso.date().nullable().optional(),
  recall: z
    .object({
      recallNumber: z.string(),
      title: z.string(),
      reason: z.string(),
      severity: z.string(),
    })
    .optional(),
});
@Injectable()
export class RecallProxy {
  constructor(
    private readonly config: ConfigService,
    private readonly organizations: OrganizationProxy,
  ) {}
  async forward(
    method: string,
    path: string,
    userId: string,
    body?: unknown,
    responseHeaders?: { setHeader(name: string, value: string): unknown },
  ) {
    const organizationId = path.split('/')[2]!;
    const access = (await this.organizations.forward(
      'GET',
      `/organizations/${organizationId}/access`,
      userId,
    )) as { organizationId: string; userId: string; role: OrganizationRole };
    if (access.organizationId !== organizationId || access.userId !== userId)
      throw new BadGatewayException('Invalid authorization context');
    const verification = path.endsWith('/verification');
    if (
      method !== 'GET' &&
      !verification &&
      !canWriteOrganizationResource(access.role, 'recall')
    )
      throw new HttpException('Organization write permission required', 403);
    const base = this.config.get<string>('RECALL_SERVICE_URL');
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException('Recall Service unavailable');
    const time = String(Date.now());
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const signature = createHmac('sha256', secret)
      .update(
        productIdentityPayload(
          method,
          path,
          time,
          userId,
          raw,
          organizationId,
          access.role,
        ),
      )
      .digest('hex');
    const signal = AbortSignal.timeout(30000);
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
          'x-identity-time': time,
          'x-identity-signature': signature,
        },
        ...(method === 'GET' ? {} : { body: raw }),
      });
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Recall request timed out');
      throw new ServiceUnavailableException('Recall Service unavailable');
    }
    if (!response.ok) {
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        if (retry && /^\d{1,5}$/.test(retry))
          responseHeaders?.setHeader('Retry-After', retry);
      }
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Invalid recall or verification input',
        429: 'Verification rate limit exceeded',
        401: 'Authentication required',
        403: 'Organization permission required',
        404: 'Recall or reference not found',
        409: 'Recall conflict: check lifecycle, scope and recall number',
        502: 'Invalid downstream reference response',
        503: 'Reference service unavailable',
        504: 'Reference request timed out',
      };
      throw new HttpException(
        messages[response.status] ??
          'Recall Service returned an invalid response',
        messages[response.status] ? response.status : 502,
      );
    }
    try {
      const data: unknown = await response.json();
      if (verification) return verificationSchema.parse(data);
      if (method === 'GET' && path.split('?')[0]!.endsWith('/recalls')) {
        const result = z
          .object({
            items: recallSchema.array(),
            total: z.number().int().nonnegative(),
            page: z.number().int().positive(),
            pageSize: z.number().int().min(1).max(100),
          })
          .parse(data);
        if (result.items.some((r) => r.organizationId !== organizationId))
          throw new Error();
        return result;
      }
      const row = recallSchema.parse(data);
      const target = path.split('?')[0]!.split('/')[4];
      if (
        row.organizationId !== organizationId ||
        (target && row.id !== target)
      )
        throw new Error();
      return row;
    } catch {
      throw new BadGatewayException(
        'Recall Service returned an invalid response',
      );
    }
  }
}
