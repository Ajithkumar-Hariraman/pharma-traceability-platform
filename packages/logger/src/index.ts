import type { LoggerOptions } from 'pino';
export function createLoggerOptions(
  service: string,
  level: string,
): LoggerOptions {
  return {
    name: service,
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-identity-signature"]',
        'req.body.password',
        'req.body.refreshToken',
        'res.body.accessToken',
        'res.body.refreshToken',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
  };
}
