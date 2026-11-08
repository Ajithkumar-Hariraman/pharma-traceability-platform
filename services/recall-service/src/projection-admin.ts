import 'reflect-metadata';
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { ConfigService } from '@nestjs/config';
import { DynamoStore } from '@pharma/dynamodb';
import { VerificationProjection } from './verification-projection';
import { VerificationService } from './verification.service';
import { ReferenceClient } from './reference.client';
import { PrismaService } from './persistence/prisma.service';
import { validateRecallEnvironment } from '@pharma/config';
import { z } from 'zod';

async function main() {
  const settings = validateRecallEnvironment(process.env);
  const config = new ConfigService(settings);
  const store = new DynamoStore(config);
  if (process.argv[2] === 'init') {
    const client = new DynamoDBClient({
      region: store.settings.AWS_REGION,
      endpoint: store.settings.DYNAMODB_ENDPOINT,
    });
    try {
      try {
        await client.send(
          new DescribeTableCommand({
            TableName: store.settings.DYNAMODB_TABLE,
          }),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== 'ResourceNotFoundException'
        )
          throw error;
        await client.send(
          new CreateTableCommand({
            TableName: store.settings.DYNAMODB_TABLE,
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [
              { AttributeName: 'PK', KeyType: 'HASH' },
              { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
            AttributeDefinitions: [
              { AttributeName: 'PK', AttributeType: 'S' },
              { AttributeName: 'SK', AttributeType: 'S' },
            ],
          }),
        );
      }
      console.log(
        JSON.stringify({
          table: store.settings.DYNAMODB_TABLE,
          initialized: true,
        }),
      );
    } finally {
      client.destroy();
      store.onModuleDestroy();
    }
    return;
  }
  if (process.argv[2] !== 'rebuild')
    throw new Error(
      'Use init or rebuild <organizationId> <userId> [after] [maxPages]',
    );
  const organizationId = z.string().uuid().parse(process.argv[3]);
  const userId = z.string().uuid().parse(process.argv[4]);
  const after = z
    .string()
    .uuid()
    .optional()
    .parse(process.argv[5] === '-' ? undefined : process.argv[5]);
  const refs = new ReferenceClient(config);
  const db = new PrismaService(
    new ConfigService<ReturnType<typeof validateRecallEnvironment>, true>(
      settings,
    ),
  );
  const projection = new VerificationProjection(store, refs);
  if (!projection.enabled)
    throw new Error('Projection must be enabled for rebuild');
  try {
    const service = new VerificationService(db, refs, undefined, projection);
    const identity = { organizationId, userId, role: 'ORG_ADMIN' as const };
    const cursor = await projection.rebuild(
      identity,
      (input) => service.authoritative(identity, input, undefined, true),
      after,
      Number(process.argv[6] ?? 1),
    );
    console.log(
      JSON.stringify({
        organizationId,
        nextCursor: cursor ?? null,
        complete: !cursor,
      }),
    );
  } finally {
    await db.$disconnect();
    store.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
