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
  type OrganizationRole,
} from '@pharma/contracts';
import { OrganizationProxy } from '../organizations/organization-proxy';
const documentSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    domainId: z.string().uuid(),
    domainType: z.enum(['PRODUCT', 'RECALL', 'SHIPMENT']),
    category: z.string(),
    originalFileName: z.string(),
    contentType: z.string(),
    size: z.number().int().positive(),
    status: z.enum(['PENDING', 'ACTIVE', 'DELETING', 'DELETED']),
    uploadedBy: z.string().uuid(),
    createdAt: z.string().datetime(),
    finalizedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
  })
  .strip();
@Injectable()
export class DocumentProxy {
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
      (access.role === 'VIEWER' ||
        (method === 'DELETE' && access.role !== 'ORG_ADMIN'))
    )
      throw new HttpException(
        'Organization administrator permission required',
        403,
      );
    const domain = path.split('/')[3]!;
    const service = (
      {
        products: 'PRODUCT_SERVICE_URL',
        recalls: 'RECALL_SERVICE_URL',
        shipments: 'SHIPMENT_SERVICE_URL',
      } as Record<string, string>
    )[domain];
    if (!service) throw new HttpException('Invalid document domain', 400);
    const base = this.config.get<string>(service);
    const secret = this.config.get<string>('INTERNAL_IDENTITY_SECRET');
    if (!base || !secret)
      throw new ServiceUnavailableException('Document Service is unavailable');
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
        throw new GatewayTimeoutException('Document Service request timed out');
      throw new ServiceUnavailableException('Document Service is unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Invalid document metadata or uploaded object',
        401: 'Authentication required',
        403: 'Organization access or administrator permission required',
        404: 'Document not found',
        409: 'Document is expired or unavailable',
        503: 'Object storage unavailable',
      };
      const message = messages[response.status];
      if (message) throw new HttpException(message, response.status);
      throw new BadGatewayException(
        'Document Service returned an invalid response',
      );
    }
    try {
      const json: unknown = await response.json();
      const signedUrl = z
        .string()
        .url()
        .refine((value) =>
          ['http:', 'https:'].includes(new URL(value).protocol),
        );
      const schema =
        method === 'DELETE'
          ? z.object({ deleted: z.literal(true) })
          : path.endsWith('/download')
            ? z.object({ url: signedUrl })
            : path.endsWith('/uploads')
              ? z.object({
                  document: documentSchema,
                  url: signedUrl,
                  headers: z.record(z.string(), z.string()),
                })
              : method === 'GET'
                ? documentSchema.array().max(200)
                : documentSchema;
      const data = schema.parse(json);
      const rows = Array.isArray(data)
        ? data
        : 'document' in data
          ? [data.document]
          : 'organizationId' in data
            ? [data]
            : [];
      if (
        rows.some((value) => {
          const row = documentSchema.parse(value);
          return (
            row.organizationId !== organizationId ||
            row.domainId !== path.split('/')[4] ||
            row.domainType !==
              (
                {
                  products: 'PRODUCT',
                  recalls: 'RECALL',
                  shipments: 'SHIPMENT',
                } as Record<string, string>
              )[domain]
          );
        })
      )
        throw new Error('Invalid ownership');
      return data;
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Document Service request timed out');
      throw new BadGatewayException(
        'Document Service returned an invalid response',
      );
    }
  }
}
