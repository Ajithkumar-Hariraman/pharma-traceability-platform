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
  RECALL_SERVICE_URL?: string;
  AUTH_SERVICE_URL: string;
  AUTH_SERVICE_TIMEOUT_MS: number;
  SHIPMENT_SERVICE_URL?: string;
  SHIPMENT_SERVICE_TIMEOUT_MS?: number;
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
    ...(input.RECALL_SERVICE_URL !== undefined
      ? (() => {
          if (!input.ORGANIZATION_SERVICE_URL)
            throw new Error('ORGANIZATION_SERVICE_URL is required for Recall');
          return {
            RECALL_SERVICE_URL: validateServiceUrl(
              input.RECALL_SERVICE_URL,
              'RECALL_SERVICE_URL',
            ),
          };
        })()
      : {}),
    AUTH_SERVICE_TIMEOUT_MS: timeout,
    ...(input.TRACEABILITY_SERVICE_URL !== undefined
      ? {
          TRACEABILITY_SERVICE_URL: validateServiceUrl(
            input.TRACEABILITY_SERVICE_URL,
            'TRACEABILITY_SERVICE_URL',
          ),
        }
      : {}),
    ...(input.SHIPMENT_SERVICE_URL !== undefined
      ? (() => {
          if (!input.ORGANIZATION_SERVICE_URL)
            throw new Error(
              'ORGANIZATION_SERVICE_URL is required for Shipment',
            );
          return {
            SHIPMENT_SERVICE_URL: validateServiceUrl(
              input.SHIPMENT_SERVICE_URL,
              'SHIPMENT_SERVICE_URL',
            ),
            SHIPMENT_SERVICE_TIMEOUT_MS: validateShipmentTimeout(
              input.SHIPMENT_SERVICE_TIMEOUT_MS,
            ),
          };
        })()
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

export interface SerializationEnvironment
  extends OrganizationEnvironment, KafkaEnvironment {
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
    ...validateKafkaEnvironment(input),
    ...validateOutboxEnvironment(input),
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

export type TraceabilityEnvironment = OrganizationEnvironment &
  KafkaEnvironment & {
    TRACE_CAPTURE_SECRET: string;
  };
export function validateTraceabilityEnvironment(
  input: Record<string, unknown>,
): TraceabilityEnvironment {
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3007),
    ...validateKafkaEnvironment(input),
    ...validateOutboxEnvironment(input),
    TRACE_CAPTURE_SECRET: validateInternalSecret(input.TRACE_CAPTURE_SECRET),
  };
}

export interface AggregationEnvironment
  extends OrganizationEnvironment, KafkaEnvironment {
  SERIALIZATION_SERVICE_URL: string;
  SERIALIZATION_SERVICE_TIMEOUT_MS: number;
  TRACEABILITY_SERVICE_URL: string;
  TRACE_CAPTURE_SECRET: string;
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
    ...validateKafkaEnvironment(input),
    ...validateOutboxEnvironment(input),
    SERIALIZATION_SERVICE_URL: validateServiceUrl(
      input.SERIALIZATION_SERVICE_URL,
      'SERIALIZATION_SERVICE_URL',
    ),
    SERIALIZATION_SERVICE_TIMEOUT_MS: Number(raw),
    TRACEABILITY_SERVICE_URL: validateServiceUrl(
      input.TRACEABILITY_SERVICE_URL ?? 'http://127.0.0.1:3007',
      'TRACEABILITY_SERVICE_URL',
    ),
    TRACE_CAPTURE_SECRET: validateInternalSecret(
      input.TRACE_CAPTURE_SECRET ?? input.INTERNAL_IDENTITY_SECRET,
    ),
  };
}

export interface ShipmentEnvironment
  extends OrganizationEnvironment, KafkaEnvironment {
  ORGANIZATION_SERVICE_URL: string;
  SERIALIZATION_SERVICE_URL: string;
  AGGREGATION_SERVICE_URL: string;
  TRACEABILITY_SERVICE_URL: string;
  TRACE_CAPTURE_SECRET: string;
  REFERENCE_TIMEOUT_MS: number;
}
export function validateShipmentEnvironment(
  input: Record<string, unknown>,
): ShipmentEnvironment {
  const timeout = Number(input.REFERENCE_TIMEOUT_MS ?? 2000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new Error('Invalid REFERENCE_TIMEOUT_MS');
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3008),
    ...validateKafkaEnvironment(input),
    ...validateOutboxEnvironment(input),
    ORGANIZATION_SERVICE_URL: validateServiceUrl(
      input.ORGANIZATION_SERVICE_URL,
      'ORGANIZATION_SERVICE_URL',
    ),
    SERIALIZATION_SERVICE_URL: validateServiceUrl(
      input.SERIALIZATION_SERVICE_URL,
      'SERIALIZATION_SERVICE_URL',
    ),
    AGGREGATION_SERVICE_URL: validateServiceUrl(
      input.AGGREGATION_SERVICE_URL,
      'AGGREGATION_SERVICE_URL',
    ),
    TRACEABILITY_SERVICE_URL: validateServiceUrl(
      input.TRACEABILITY_SERVICE_URL,
      'TRACEABILITY_SERVICE_URL',
    ),
    TRACE_CAPTURE_SECRET: validateInternalSecret(
      input.TRACE_CAPTURE_SECRET ?? input.INTERNAL_IDENTITY_SECRET,
    ),
    REFERENCE_TIMEOUT_MS: timeout,
  };
}

function validateShipmentTimeout(value: unknown): number {
  const timeout = Number(value ?? 30000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new Error('Invalid SHIPMENT_SERVICE_TIMEOUT_MS');
  return timeout;
}

export function validateKafkaEnvironment(input: Record<string, unknown>) {
  const mode = input.EVENT_TRANSPORT ?? 'http';
  if (mode !== 'http' && mode !== 'kafka')
    throw new Error('Invalid EVENT_TRANSPORT');
  const brokers = String(input.KAFKA_BROKERS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (
    (mode === 'kafka' && !brokers.length) ||
    brokers.some(
      (v) =>
        !/^[a-zA-Z0-9.-]+:\d+$/.test(v) ||
        Number(v.split(':')[1]) < 1 ||
        Number(v.split(':')[1]) > 65535,
    )
  )
    throw new Error('Invalid KAFKA_BROKERS');
  const identifier = (key: string, fallback: string) => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(value))
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const timeout = (key: string, fallback: number) => {
    const value = input[key] ?? fallback;
    if (
      !/^\d+$/.test(String(value)) ||
      Number(value) < 1 ||
      Number(value) > 60000
    )
      throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  if (
    input.KAFKA_SSL !== undefined &&
    !['true', 'false'].includes(String(input.KAFKA_SSL))
  )
    throw new Error('Invalid KAFKA_SSL');
  const mechanism = input.KAFKA_SASL_MECHANISM;
  if (
    mechanism !== undefined &&
    !['plain', 'scram-sha-256', 'scram-sha-512'].includes(String(mechanism))
  )
    throw new Error('Invalid KAFKA_SASL_MECHANISM');
  if (
    mechanism &&
    (typeof input.KAFKA_SASL_USERNAME !== 'string' ||
      !input.KAFKA_SASL_USERNAME ||
      typeof input.KAFKA_SASL_PASSWORD !== 'string' ||
      !input.KAFKA_SASL_PASSWORD ||
      String(input.KAFKA_SSL) !== 'true')
  )
    throw new Error('Kafka SASL requires credentials and TLS');
  return {
    EVENT_TRANSPORT: mode,
    KAFKA_BROKERS: brokers.join(','),
    KAFKA_CLIENT_ID: identifier('KAFKA_CLIENT_ID', 'pharma'),
    KAFKA_CONSUMER_GROUP_ID: identifier(
      'KAFKA_CONSUMER_GROUP_ID',
      'traceability-v1',
    ),
    KAFKA_CONNECTION_TIMEOUT_MS: timeout('KAFKA_CONNECTION_TIMEOUT_MS', 3000),
    KAFKA_REQUEST_TIMEOUT_MS: timeout('KAFKA_REQUEST_TIMEOUT_MS', 10000),
    KAFKA_SSL: String(input.KAFKA_SSL) === 'true',
    KAFKA_SASL_MECHANISM: mechanism,
    KAFKA_SASL_USERNAME: input.KAFKA_SASL_USERNAME,
    KAFKA_SASL_PASSWORD: input.KAFKA_SASL_PASSWORD,
  };
}

export type KafkaEnvironment = ReturnType<typeof validateKafkaEnvironment> &
  OutboxEnvironment;

export function validateOutboxEnvironment(input: Record<string, unknown>) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = input[key] ?? fallback;
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      !/^\d+$/.test(String(value)) ||
      Number(value) < min ||
      Number(value) > max
    )
      throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  const settings = {
    OUTBOX_POLL_INTERVAL_MS: number(
      'OUTBOX_POLL_INTERVAL_MS',
      1000,
      100,
      60000,
    ),
    OUTBOX_BATCH_SIZE: number('OUTBOX_BATCH_SIZE', 20, 1, 200),
    OUTBOX_MAX_ATTEMPTS: number('OUTBOX_MAX_ATTEMPTS', 20, 1, 1000),
    OUTBOX_RETRY_BASE_MS: number('OUTBOX_RETRY_BASE_MS', 1000, 100, 60000),
    OUTBOX_RETRY_MAX_MS: number('OUTBOX_RETRY_MAX_MS', 300000, 100, 3600000),
    OUTBOX_LEASE_MS: number('OUTBOX_LEASE_MS', 60000, 3000, 3600000),
    OUTBOX_RETENTION_DAYS: number('OUTBOX_RETENTION_DAYS', 7, 1, 365),
  };
  if (settings.OUTBOX_RETRY_MAX_MS < settings.OUTBOX_RETRY_BASE_MS)
    throw new Error(
      'OUTBOX_RETRY_MAX_MS must be at least OUTBOX_RETRY_BASE_MS',
    );
  return settings;
}
export type OutboxEnvironment = ReturnType<typeof validateOutboxEnvironment>;

export function validateRecallEnvironment(input: Record<string, unknown>) {
  const timeout = Number(input.REFERENCE_TIMEOUT_MS ?? 3000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new Error('Invalid REFERENCE_TIMEOUT_MS');
  const kafka = validateKafkaEnvironment({
    ...input,
    EVENT_TRANSPORT: input.EVENT_TRANSPORT ?? 'kafka',
  });
  if (kafka.EVENT_TRANSPORT !== 'kafka')
    throw new Error('Recall requires Kafka and transactional Outbox');
  return {
    ...validateOrganizationEnvironment(input),
    ...validateEnvironment(input, 3009),
    ...kafka,
    ...validateOutboxEnvironment(input),
    ...validateRedisEnvironment(input),
    ...validateDynamoEnvironment(input),
    REFERENCE_TIMEOUT_MS: timeout,
    PRODUCT_SERVICE_URL: validateServiceUrl(
      input.PRODUCT_SERVICE_URL,
      'PRODUCT_SERVICE_URL',
    ),
    BATCH_SERVICE_URL: validateServiceUrl(
      input.BATCH_SERVICE_URL,
      'BATCH_SERVICE_URL',
    ),
    SERIALIZATION_SERVICE_URL: validateServiceUrl(
      input.SERIALIZATION_SERVICE_URL,
      'SERIALIZATION_SERVICE_URL',
    ),
  };
}
export type RecallEnvironment = ReturnType<typeof validateRecallEnvironment>;

export function validateRedisEnvironment(input: Record<string, unknown>) {
  const number = (key: string, fallback: number, max: number) => {
    const value = input[key] ?? fallback;
    if (
      !/^\d+$/.test(String(value)) ||
      Number(value) < 1 ||
      Number(value) > max
    )
      throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  const url = String(input.REDIS_URL ?? 'redis://127.0.0.1:6379');
  try {
    const parsed = new URL(url);
    if (
      !['redis:', 'rediss:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      (parsed.port && Number(parsed.port) > 65535)
    )
      throw new Error();
  } catch {
    throw new Error('Invalid REDIS_URL');
  }
  return {
    REDIS_URL: url,
    REDIS_CONNECT_TIMEOUT_MS: number('REDIS_CONNECT_TIMEOUT_MS', 500, 10000),
    REDIS_COMMAND_TIMEOUT_MS: number('REDIS_COMMAND_TIMEOUT_MS', 500, 10000),
    VERIFICATION_CACHE_TTL_SECONDS: number(
      'VERIFICATION_CACHE_TTL_SECONDS',
      30,
      300,
    ),
    VERIFICATION_UNKNOWN_TTL_SECONDS: number(
      'VERIFICATION_UNKNOWN_TTL_SECONDS',
      5,
      60,
    ),
    VERIFICATION_RATE_LIMIT: number('VERIFICATION_RATE_LIMIT', 60, 100000),
    VERIFICATION_RATE_WINDOW_SECONDS: number(
      'VERIFICATION_RATE_WINDOW_SECONDS',
      60,
      3600,
    ),
  };
}

export function validateDynamoEnvironment(input: Record<string, unknown>) {
  const table = String(input.DYNAMODB_TABLE ?? 'pharma-verification');
  const region = String(input.AWS_REGION ?? 'us-east-1');
  const endpoint = input.DYNAMODB_ENDPOINT
    ? String(input.DYNAMODB_ENDPOINT)
    : undefined;
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table))
    throw new Error('Invalid DYNAMODB_TABLE');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
    throw new Error('Invalid AWS_REGION');
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid DYNAMODB_ENDPOINT');
  }
  const enabled = input.VERIFICATION_PROJECTION_ENABLED ?? 'false';
  if (![true, false, 'true', 'false'].includes(enabled as string))
    throw new Error('Invalid VERIFICATION_PROJECTION_ENABLED');
  const timeout = Number(input.DYNAMODB_TIMEOUT_MS ?? 1000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new Error('Invalid DYNAMODB_TIMEOUT_MS');
  return {
    DYNAMODB_TABLE: table,
    AWS_REGION: region,
    DYNAMODB_ENDPOINT: endpoint,
    DYNAMODB_TIMEOUT_MS: timeout,
    VERIFICATION_PROJECTION_ENABLED: enabled === true || enabled === 'true',
  };
}

export function validateStorageEnvironment(input: Record<string, unknown>) {
  const number = (key: string, fallback: number, max: number) => {
    const value = Number(input[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const bucket = String(input.S3_BUCKET ?? 'pharma-documents');
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes('..')
  )
    throw new Error('Invalid S3_BUCKET');
  const region = String(input.AWS_REGION ?? 'us-east-1');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
    throw new Error('Invalid AWS_REGION');
  const endpoint = input.S3_ENDPOINT ? String(input.S3_ENDPOINT) : undefined;
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Invalid S3_ENDPOINT');
  }
  const pathStyle = input.S3_FORCE_PATH_STYLE ?? 'false';
  if (![true, false, 'true', 'false'].includes(pathStyle as string))
    throw new Error('Invalid S3_FORCE_PATH_STYLE');
  const allowed = String(
    input.DOCUMENT_ALLOWED_CONTENT_TYPES ??
      'application/pdf,image/png,image/jpeg,text/csv',
  ).split(',');
  if (
    !allowed.length ||
    allowed.some(
      (x) =>
        !['application/pdf', 'image/png', 'image/jpeg', 'text/csv'].includes(x),
    )
  )
    throw new Error('Invalid DOCUMENT_ALLOWED_CONTENT_TYPES');
  if (!!input.AWS_ACCESS_KEY_ID !== !!input.AWS_SECRET_ACCESS_KEY)
    throw new Error('Incomplete AWS credentials');
  if (
    number('DOCUMENT_PENDING_TTL_SECONDS', 3600, 86400) <
    number('S3_UPLOAD_EXPIRY_SECONDS', 300, 900) + 60
  )
    throw new Error(
      'DOCUMENT_PENDING_TTL_SECONDS must exceed upload expiry by 60 seconds',
    );
  return {
    S3_BUCKET: bucket,
    AWS_REGION: region,
    S3_ENDPOINT: endpoint,
    S3_FORCE_PATH_STYLE: pathStyle === true || pathStyle === 'true',
    DOCUMENT_ALLOWED_CONTENT_TYPES: allowed,
    DOCUMENT_MAX_FILE_SIZE: number(
      'DOCUMENT_MAX_FILE_SIZE',
      10485760,
      104857600,
    ),
    S3_UPLOAD_EXPIRY_SECONDS: number('S3_UPLOAD_EXPIRY_SECONDS', 300, 900),
    S3_DOWNLOAD_EXPIRY_SECONDS: number('S3_DOWNLOAD_EXPIRY_SECONDS', 120, 900),
    DOCUMENT_PENDING_TTL_SECONDS: number(
      'DOCUMENT_PENDING_TTL_SECONDS',
      3600,
      86400,
    ),
  };
}
