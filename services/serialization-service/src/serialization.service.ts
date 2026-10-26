import { randomUUID } from 'node:crypto';
import { TraceCaptureClient } from './trace-capture.client';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  normalizeSerialNumber,
  MAX_BULK_SERIALS,
  canTransitionSerial,
  canExecuteSerialCommand,
  type OrganizationRole,
  type SerialCommand,
  type BatchReference,
  type SerializedItemStatus,
} from '@pharma/contracts';
import { SerializationRepository } from './serialization.repository';
import { BatchValidationClient } from './batch-validation.client';
const serialNumber = z.string().transform((value, ctx) => {
  const normalized = normalizeSerialNumber(value);
  if (normalized === null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid serial number' });
    return z.NEVER;
  }
  return normalized;
});
const single = z.object({ serialNumber }).strict();
const bulk = z
  .object({ serialNumbers: z.array(serialNumber).min(1).max(MAX_BULK_SERIALS) })
  .strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(
      'Invalid serial input. Use non-empty strings up to 100 characters and 1–100 entries for bulk creation',
    );
  return result.data;
}
function usable(reference: BatchReference) {
  if (reference.status !== 'ACTIVE')
    throw new ConflictException(
      'Batch must be ACTIVE for serial creation or commissioning',
    );
}
@Injectable()
export class SerializationService {
  constructor(
    private readonly repository: SerializationRepository,
    private readonly batches: BatchValidationClient,
    private readonly trace: TraceCaptureClient,
  ) {}
  async create(
    organizationId: string,
    batchId: string,
    body: unknown,
    userId: string,
    role: OrganizationRole,
  ) {
    const input = parse(single, body);
    const ref = await this.batches.validate(
      organizationId,
      batchId,
      userId,
      role,
    );
    usable(ref);
    return this.unique(() =>
      this.repository.create({
        organizationId,
        batchId,
        productId: ref.productId,
        gtinId: ref.gtinId,
        ...input,
      }),
    );
  }
  async bulk(
    organizationId: string,
    batchId: string,
    body: unknown,
    userId: string,
    role: OrganizationRole,
  ) {
    const { serialNumbers } = parse(bulk, body);
    if (new Set(serialNumbers).size !== serialNumbers.length)
      throw new ConflictException('Duplicate serial numbers in bulk request');
    const ref = await this.batches.validate(
      organizationId,
      batchId,
      userId,
      role,
    );
    usable(ref);
    return this.unique(() =>
      this.repository.bulk(
        serialNumbers.map((serialNumber) => ({
          organizationId,
          batchId,
          productId: ref.productId,
          gtinId: ref.gtinId,
          serialNumber,
        })),
      ),
    );
  }
  async list(
    organizationId: string,
    batchId: string,
    userId: string,
    role: OrganizationRole,
  ) {
    await this.batches.validate(organizationId, batchId, userId, role);
    return this.repository.list(organizationId, batchId);
  }
  async get(organizationId: string, id: string) {
    const row = await this.repository.find(organizationId, id);
    if (!row) throw new NotFoundException('Serialized item not found');
    return row;
  }
  async patch(organizationId: string, id: string) {
    await this.get(organizationId, id);
    throw new BadRequestException(
      'Serialized identity is immutable. Use dedicated lifecycle commands',
    );
  }
  async command(
    organizationId: string,
    id: string,
    command: SerialCommand,
    body: unknown,
    userId: string,
    role: OrganizationRole,
  ) {
    parse(z.object({}).strict(), body ?? {});
    if (!canExecuteSerialCommand(role, command))
      throw new ForbiddenException('Serial command permission required');
    const row = await this.get(organizationId, id);
    if (!canTransitionSerial(row.status, command))
      throw new ConflictException(
        'Invalid serialized item lifecycle transition',
      );
    const ref = await this.batches.validate(
      organizationId,
      row.batchId,
      userId,
      role,
    );
    if (ref.productId !== row.productId || ref.gtinId !== row.gtinId)
      throw new ConflictException('Batch reference has changed');
    if (command === 'commission') usable(ref);
    const to: SerializedItemStatus =
      command === 'commission'
        ? 'COMMISSIONED'
        : command === 'decommission'
          ? 'DECOMMISSIONED'
          : 'QUARANTINED';
    const result = await this.repository.transition(
      organizationId,
      id,
      row.status,
      to,
    );
    if (!result)
      throw new ConflictException(
        'Invalid serialized item lifecycle transition',
      );
    await this.trace.capture({
      organizationId,
      eventId: randomUUID(),
      eventType: 'OBJECT',
      action:
        command === 'commission'
          ? 'ADD'
          : command === 'decommission'
            ? 'DELETE'
            : 'OBSERVE',
      businessStep:
        command === 'commission'
          ? 'commissioning'
          : command === 'decommission'
            ? 'decommissioning'
            : 'holding',
      disposition:
        command === 'quarantine'
          ? 'quarantined'
          : command === 'decommission'
            ? 'inactive'
            : 'active',
      eventTime: result.updatedAt.toISOString(),
      serializedItemId: result.id,
      batchId: result.batchId,
      productId: result.productId,
      gtinId: result.gtinId,
      metadata: { command, userId },
    });
    return result;
  }
  private async unique<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'Serial number already exists for this GTIN',
        );
      throw error;
    }
  }
}
