import {
  Injectable,
  HttpException,
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
const user = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    status: z.literal('ACTIVE'),
  })
  .strip();
const tokens = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strip();
@Injectable()
export class AuthProxyService {
  constructor(private readonly config: ConfigService) {}
  async forward(
    action: 'register' | 'login' | 'refresh' | 'logout' | 'me',
    body?: unknown,
    authorization?: string,
  ) {
    const signal = AbortSignal.timeout(
      this.config.getOrThrow<number>('AUTH_SERVICE_TIMEOUT_MS'),
    );
    let response: Response;
    try {
      response = await fetch(
        `${this.config.getOrThrow<string>('AUTH_SERVICE_URL')}/auth/${action}`,
        {
          method: action === 'me' ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
          },
          ...(action !== 'me' ? { body: JSON.stringify(body) } : {}),
          signal,
          redirect: 'error',
        },
      );
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Auth Service request timed out');
      throw new ServiceUnavailableException('Auth Service is unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Enter a valid email and a password of 12–128 characters',
        401:
          action === 'login'
            ? 'Invalid email or password'
            : 'Your session has expired. Please sign in again',
        409: 'An account with this email already exists',
        429: 'Too many requests. Try again shortly',
      };
      const message = messages[response.status];
      if (message) throw new HttpException(message, response.status);
      throw new BadGatewayException(
        'Auth Service returned an invalid response',
      );
    }
    try {
      const data: unknown = await response.json();
      return (
        action === 'register' || action === 'me'
          ? user
          : action === 'logout'
            ? z.object({ success: z.literal(true) }).strip()
            : tokens
      ).parse(data);
    } catch {
      if (signal.aborted)
        throw new GatewayTimeoutException('Auth Service request timed out');
      throw new BadGatewayException(
        'Auth Service returned an invalid response',
      );
    }
  }
}
