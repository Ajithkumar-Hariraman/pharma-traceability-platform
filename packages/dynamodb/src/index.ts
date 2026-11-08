import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { validateDynamoEnvironment } from '@pharma/config';

@Injectable()
export class DynamoStore {
  readonly settings;
  readonly client;
  constructor(config: ConfigService) {
    this.settings = validateDynamoEnvironment(
      Object.fromEntries(
        [
          'DYNAMODB_TABLE',
          'AWS_REGION',
          'DYNAMODB_ENDPOINT',
          'DYNAMODB_TIMEOUT_MS',
          'VERIFICATION_PROJECTION_ENABLED',
        ].map((k) => [k, config.get(k)]),
      ),
    );
    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: this.settings.AWS_REGION,
        endpoint: this.settings.DYNAMODB_ENDPOINT,
        maxAttempts: 1,
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }
  async get(key: { PK: string; SK: string }) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.settings.DYNAMODB_TABLE,
          Key: key,
          ConsistentRead: true,
        }),
        { abortSignal: AbortSignal.timeout(this.settings.DYNAMODB_TIMEOUT_MS) },
      )
    ).Item;
  }
  async put(item: Record<string, unknown>, conditional = false) {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.settings.DYNAMODB_TABLE,
          Item: item,
          ...(conditional
            ? {
                ConditionExpression:
                  'attribute_not_exists(PK) OR revision < :revision',
                ExpressionAttributeValues: { ':revision': item.revision },
              }
            : {}),
        }),
        { abortSignal: AbortSignal.timeout(this.settings.DYNAMODB_TIMEOUT_MS) },
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'ConditionalCheckFailedException'
      )
        return false;
      throw error;
    }
  }
  onModuleDestroy() {
    this.client.destroy();
  }
}
