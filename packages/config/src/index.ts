export const logLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type LogLevel = (typeof logLevels)[number];

export interface AppEnvironment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  HOST: string;
  LOG_LEVEL: LogLevel;
}

export function validateEnvironment(
  input: Record<string, unknown>,
  defaultPort: number,
): AppEnvironment {
  const nodeEnv = input.NODE_ENV ?? 'development';
  if (
    nodeEnv !== 'development' &&
    nodeEnv !== 'test' &&
    nodeEnv !== 'production'
  )
    throw new Error('NODE_ENV must be development, test, or production');
  const rawPort = input.PORT ?? defaultPort;
  if (
    (typeof rawPort !== 'string' && typeof rawPort !== 'number') ||
    !/^\d+$/.test(String(rawPort))
  )
    throw new Error('PORT must be an integer between 1 and 65535');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer between 1 and 65535');
  const host = input.HOST ?? '0.0.0.0';
  if (typeof host !== 'string' || !host.trim() || /\s/.test(host))
    throw new Error('HOST must be a non-empty hostname or IP address');
  const level = input.LOG_LEVEL ?? 'info';
  if (typeof level !== 'string' || !logLevels.includes(level as LogLevel))
    throw new Error('LOG_LEVEL is invalid');
  return {
    NODE_ENV: nodeEnv,
    PORT: port,
    HOST: host,
    LOG_LEVEL: level as LogLevel,
  };
}

export interface AuthEnvironment extends AppEnvironment {
  DATABASE_URL: string;
  JWT_SECRET: string;
}

export interface GatewayEnvironment extends AppEnvironment {
  AUTH_SERVICE_URL: string;
  AUTH_SERVICE_TIMEOUT_MS: number;
  AGGREGATION_SERVICE_URL?: string;
  SERIALIZATION_SERVICE_URL?: string;
  TRACEABILITY_SERVICE_URL?: string;
  BATCH_SERVICE_URL?: string;
  PRODUCT_SERVICE_URL?: string;
  ORGANIZATION_SERVICE_URL?: string;
  INTERNAL_IDENTITY_SECRET?: string;
}

function parseUrl(value: unknown, key: string, protocols: string[]): URL {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${key} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (!protocols.includes(url.protocol) || !url.hostname)
    throw new Error(`${key} has an invalid protocol or hostname`);
  return url;
}

export function validateAuthEnvironment(
  input: Record<string, unknown>,
): AuthEnvironment {
  const url = parseUrl(input.DATABASE_URL, 'DATABASE_URL', [
    'postgresql:',
    'postgres:',
  ]);
  if (!url.username || !url.pathname.slice(1) || url.hash)
    throw new Error(
      'DATABASE_URL must identify a PostgreSQL user and database',
    );
  if (
    typeof input.JWT_SECRET !== 'string' ||
    Buffer.byteLength(input.JWT_SECRET) < 32
  )
    throw new Error('JWT_SECRET must contain at least 32 bytes');
  return {
    ...validateEnvironment(input, 3001),
    DATABASE_URL: url.toString(),
    JWT_SECRET: input.JWT_SECRET,
  };
}

export function validateGatewayEnvironment(
  input: Record<string, unknown>,
): GatewayEnvironment {
  const url = parseUrl(input.AUTH_SERVICE_URL, 'AUTH_SERVICE_URL', [
    'http:',
    'https:',
  ]);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'AUTH_SERVICE_URL must not contain credentials, query parameters, or fragments',
    );
  if (
    input.TRACEABILITY_SERVICE_URL !== undefined &&
    !input.ORGANIZATION_SERVICE_URL
  )
    throw new Error(
      'ORGANIZATION_SERVICE_URL is required for Traceability Service',
    );
  const rawTimeout = input.AUTH_SERVICE_TIMEOUT_MS ?? 2000;
  if (
    (typeof rawTimeout !== 'string' && typeof rawTimeout !== 'number') ||
    !/^\d+$/.test(String(rawTimeout))
  )
    throw new Error(
      'AUTH_SERVICE_TIMEOUT_MS must be an integer between 1 and 30000',
    );
  const timeout = Number(rawTimeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new Error(
      'AUTH_SERVICE_TIMEOUT_MS must be an integer between 1 and 30000',
    );
  return {
    ...validateEnvironment(input, 3000),
    AUTH_SERVICE_URL: url.toString().replace(/\/$/, ''),
    AUTH_SERVICE_TIMEOUT_MS: timeout,
    ...(input.TRACEABILITY_SERVICE_URL !== undefined
      ? {
          TRACEABILITY_SERVICE_URL: validateServiceUrl(
            input.TRACEABILITY_SERVICE_URL,
            'TRACEABILITY_SERVICE_URL',
          ),
        }
      : {}),
    ...(input.AGGREGATION_SERVICE_URL !== undefined
      ? (() => {
          if (!input.ORGANIZATION_SERVICE_URL)
            throw new Error(
              'ORGANIZATION_SERVICE_URL is required for Aggregation Service',
            );
          return {
            AGGREGATION_SERVICE_URL: validateServiceUrl(
              input.AGGREGATION_SERVICE_URL,
              'AGGREGATION_SERVICE_URL',
            ),
          };
        })()
      : {}),
    ...(input.SERIALIZATION_SERVICE_URL !== undefined
      ? (() => {
          const base = validateServiceUrl(
            input.SERIALIZATION_SERVICE_URL,
            'SERIALIZATION_SERVICE_URL',
          );
          if (!input.ORGANIZATION_SERVICE_URL)
            throw new Error(
              'ORGANIZATION_SERVICE_URL is required for Serialization Service',
            );
          return { SERIALIZATION_SERVICE_URL: base };
        })()
      : {}),
    ...(input.BATCH_SERVICE_URL !== undefined
      ? (() => {
          const base = validateServiceUrl(
            input.BATCH_SERVICE_URL,
            'BATCH_SERVICE_URL',
          );
          if (!input.ORGANIZATION_SERVICE_URL)
            throw new Error(
              'ORGANIZATION_SERVICE_URL is required for Batch Service',
            );
          return { BATCH_SERVICE_URL: base };
        })()
      : {}),
    ...(input.PRODUCT_SERVICE_URL !== undefined
      ? (() => {
          const productUrl = parseUrl(
            input.PRODUCT_SERVICE_URL,
            'PRODUCT_SERVICE_URL',
            ['http:', 'https:'],
          );
          if (
            productUrl.username ||
            productUrl.password ||
            productUrl.search ||
            productUrl.hash
          )
            throw new Error('Invalid PRODUCT_SERVICE_URL');
          if (!input.ORGANIZATION_SERVICE_URL)
            throw new Error(
              'ORGANIZATION_SERVICE_URL is required for Product Service',
            );
          return {
            PRODUCT_SERVICE_URL: productUrl.toString().replace(/\/$/, ''),
          };
        })()
      : {}),
    ...(input.ORGANIZATION_SERVICE_URL !== undefined
      ? (() => {
          const organizationUrl = parseUrl(
            input.ORGANIZATION_SERVICE_URL,
            'ORGANIZATION_SERVICE_URL',
            ['http:', 'https:'],
          );
          if (
            organizationUrl.username ||
            organizationUrl.password ||
            organizationUrl.search ||
            organizationUrl.hash
          )
            throw new Error(
              'ORGANIZATION_SERVICE_URL must not contain credentials, query parameters, or fragments',
            );
          return {
            ORGANIZATION_SERVICE_URL: organizationUrl
              .toString()
              .replace(/\/$/, ''),
            INTERNAL_IDENTITY_SECRET: validateInternalSecret(
              input.INTERNAL_IDENTITY_SECRET,
            ),
          };
        })()
      : {}),
  };
}

export interface OrganizationEnvironment extends AppEnvironment {
  DATABASE_URL: string;
  INTERNAL_IDENTITY_SECRET: string;
}
export function validateInternalSecret(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32)
    throw new Error('INTERNAL_IDENTITY_SECRET must contain at least 32 bytes');
  return value;
}
export function validateOrganizationEnvironment(
  input: Record<string, unknown>,
): OrganizationEnvironment {
  const url = parseUrl(input.DATABASE_URL, 'DATABASE_URL', [
    'postgresql:',
    'postgres:',
  ]);
  if (!url.username || !url.pathname.slice(1) || url.hash)
    throw new Error(
      'DATABASE_URL must identify a PostgreSQL user and database',
    );
  return {
    ...validateEnvironment(input, 3002),
    DATABASE_URL: url.toString(),
    INTERNAL_IDENTITY_SECRET: validateInternalSecret(
      input.INTERNAL_IDENTITY_SECRET,
    ),
  };
}

export type ProductEnvironment = OrganizationEnvironment;
export function validateProductEnvironment(
  input: Record<string, unknown>,
): ProductEnvironment {
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3003),
  };
}

function validateServiceUrl(value: unknown, key: string): string {
  const url = parseUrl(value, key, ['http:', 'https:']);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(`${key} must be an HTTP service origin`);
  return url.toString().replace(/\/$/, '');
}
export interface BatchEnvironment extends OrganizationEnvironment {
  PRODUCT_SERVICE_URL: string;
  PRODUCT_SERVICE_TIMEOUT_MS: number;
}
export function validateBatchEnvironment(
  input: Record<string, unknown>,
): BatchEnvironment {
  const raw = input.PRODUCT_SERVICE_TIMEOUT_MS ?? 2000;
  if (
    (typeof raw !== 'string' && typeof raw !== 'number') ||
    !/^\d+$/.test(String(raw)) ||
    Number(raw) < 1 ||
    Number(raw) > 30000
  )
    throw new Error(
      'PRODUCT_SERVICE_TIMEOUT_MS must be an integer between 1 and 30000',
    );
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3004),
    PRODUCT_SERVICE_URL: validateServiceUrl(
      input.PRODUCT_SERVICE_URL,
      'PRODUCT_SERVICE_URL',
    ),
    PRODUCT_SERVICE_TIMEOUT_MS: Number(raw),
  };
}

export interface SerializationEnvironment extends OrganizationEnvironment {
  TRACEABILITY_SERVICE_URL: string;
  TRACE_CAPTURE_SECRET: string;
  BATCH_SERVICE_URL: string;
  BATCH_SERVICE_TIMEOUT_MS: number;
}
export function validateSerializationEnvironment(
  input: Record<string, unknown>,
): SerializationEnvironment {
  const raw = input.BATCH_SERVICE_TIMEOUT_MS ?? 2000;
  if (
    (typeof raw !== 'string' && typeof raw !== 'number') ||
    !/^\d+$/.test(String(raw)) ||
    Number(raw) < 1 ||
    Number(raw) > 30000
  )
    throw new Error(
      'BATCH_SERVICE_TIMEOUT_MS must be an integer between 1 and 30000',
    );
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3005),
    BATCH_SERVICE_URL: validateServiceUrl(
      input.BATCH_SERVICE_URL,
      'BATCH_SERVICE_URL',
    ),
    BATCH_SERVICE_TIMEOUT_MS: Number(raw),
    TRACEABILITY_SERVICE_URL: validateServiceUrl(
      input.TRACEABILITY_SERVICE_URL ?? 'http://127.0.0.1:3007',
      'TRACEABILITY_SERVICE_URL',
    ),
    TRACE_CAPTURE_SECRET: validateInternalSecret(
      input.TRACE_CAPTURE_SECRET ?? input.INTERNAL_IDENTITY_SECRET,
    ),
  };
}

export type TraceabilityEnvironment = OrganizationEnvironment & {
  TRACE_CAPTURE_SECRET: string;
};
export function validateTraceabilityEnvironment(
  input: Record<string, unknown>,
): TraceabilityEnvironment {
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3007),
    TRACE_CAPTURE_SECRET: validateInternalSecret(input.TRACE_CAPTURE_SECRET),
  };
}

export interface AggregationEnvironment extends OrganizationEnvironment {
  SERIALIZATION_SERVICE_URL: string;
  SERIALIZATION_SERVICE_TIMEOUT_MS: number;
}
export function validateAggregationEnvironment(
  input: Record<string, unknown>,
): AggregationEnvironment {
  const raw = input.SERIALIZATION_SERVICE_TIMEOUT_MS ?? 2000;
  if (
    (typeof raw !== 'string' && typeof raw !== 'number') ||
    !/^\d+$/.test(String(raw)) ||
    Number(raw) < 1 ||
    Number(raw) > 30000
  )
    throw new Error(
      'SERIALIZATION_SERVICE_TIMEOUT_MS must be an integer between 1 and 30000',
    );
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3006),
    SERIALIZATION_SERVICE_URL: validateServiceUrl(
      input.SERIALIZATION_SERVICE_URL,
      'SERIALIZATION_SERVICE_URL',
    ),
    SERIALIZATION_SERVICE_TIMEOUT_MS: Number(raw),
  };
}
