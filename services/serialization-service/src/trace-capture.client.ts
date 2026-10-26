import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { traceCapturePayload, type TraceCapture } from '@pharma/contracts';
@Injectable()
export class TraceCaptureClient {
  constructor(private readonly config: ConfigService) {}
  async capture(event: TraceCapture) {
    const path = `/internal/organizations/${event.organizationId}/trace/events`;
    const time = String(Date.now());
    const raw = JSON.stringify(event);
    const secret =
      this.config.get<string>('TRACE_CAPTURE_SECRET') ??
      this.config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET');
    const signature = createHmac('sha256', secret)
      .update(
        traceCapturePayload(
          'POST',
          path,
          time,
          'serialization-service',
          event.organizationId,
          raw,
        ),
      )
      .digest('hex');
    try {
      const response = await fetch(
        `${this.config.get<string>('TRACEABILITY_SERVICE_URL') ?? 'http://127.0.0.1:3007'}${path}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(2000),
          headers: {
            'Content-Type': 'application/json',
            'x-trace-caller': 'serialization-service',
            'x-identity-organization': event.organizationId,
            'x-identity-time': time,
            'x-identity-signature': signature,
          },
          body: raw,
        },
      );
      await response.body?.cancel();
      if (!response.ok) throw new Error('Capture rejected');
    } catch {
      throw new ServiceUnavailableException({
        message:
          'Business state changed, but trace capture failed. Do not repeat the lifecycle command. Reconcile using the event payload.',
        code: 'TRACE_CAPTURE_FAILED',
        businessStateChanged: true,
        event,
      });
    }
  }
}
