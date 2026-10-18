import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GatewayEnvironment } from '@pharma/config';
import type { HealthResponse } from '@pharma/contracts';
@Injectable()
export class AuthHealthService {
  constructor(
    private readonly config: ConfigService<GatewayEnvironment, true>,
  ) {}
  async check(): Promise<HealthResponse> {
    const signal = AbortSignal.timeout(
      this.config.get('AUTH_SERVICE_TIMEOUT_MS', { infer: true }),
    );
    let response: Response;
    try {
      response = await fetch(
        `${this.config.get('AUTH_SERVICE_URL', { infer: true })}/health`,
        { signal, redirect: 'error' },
      );
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Auth Service request timed out');
      throw new ServiceUnavailableException('Auth Service is unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BadGatewayException(
        'Auth Service returned an invalid response',
      );
    }
    try {
      const body: unknown = await response.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !('service' in body) ||
        body.service !== 'auth-service' ||
        !('status' in body) ||
        body.status !== 'ok'
      )
        throw new Error('Invalid health response');
      return { service: 'auth-service', status: 'ok' };
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Auth Service request timed out');
      throw new BadGatewayException(
        'Auth Service returned an invalid response',
      );
    }
  }
}
