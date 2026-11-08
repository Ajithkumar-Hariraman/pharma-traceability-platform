import { VerificationCache } from './verification-cache';
import {
  Injectable,
  Optional,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { recallStatuses, recallSeverities } from '@pharma/contracts';
import { enqueueEvent, eventSchema } from '@pharma/messaging';
import { PrismaService } from './persistence/prisma.service';
import { ReferenceClient, type Identity } from './reference.client';
const id = z.string().uuid();
export const createSchema = z
  .object({
    recallNumber: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(4000),
    severity: z.enum(recallSeverities).default('CLASS_II'),
    productId: id,
    gtinId: id.optional(),
    batchId: id.optional(),
  })
  .strict();
export const listSchema = z
  .object({
    status: z.enum(recallStatuses).optional(),
    productId: id.optional(),
    gtinId: id.optional(),
    batchId: id.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to));
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException('Invalid recall or verification input');
  return result.data;
}
@Injectable()
export class RecallService {
  constructor(
    private readonly db: PrismaService,
    private readonly refs: ReferenceClient,
    @Optional() private readonly cache?: VerificationCache,
  ) {}
  async create(identity: Identity, body: unknown) {
    const input = parse(createSchema, body);
    await this.refs.scope(input, identity);
    return this.unique(() =>
      this.db.recall.create({
        data: {
          ...input,
          organizationId: identity.organizationId,
          createdBy: identity.userId,
          scopeKey: input.batchId
            ? `batch:${input.batchId}`
            : input.gtinId
              ? `gtin:${input.gtinId}`
              : `product:${input.productId}`,
        },
      }),
    );
  }
  async get(organizationId: string, id: string) {
    const row = await this.db.recall.findFirst({
      where: { organizationId, id },
    });
    if (!row) throw new NotFoundException('Recall not found');
    return row;
  }
  async list(organizationId: string, query: unknown) {
    const { page, pageSize, from, to, ...filters } = parse(listSchema, query);
    const where = {
      organizationId,
      ...filters,
      createdAt: {
        gte: from ? new Date(from) : undefined,
        lte: to ? new Date(to) : undefined,
      },
    };
    const [items, total] = await this.db.$transaction(
      [
        this.db.recall.findMany({
          where,
          take: pageSize,
          skip: (page - 1) * pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.db.recall.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return { items, total, page, pageSize };
  }
  async command(
    identity: Identity,
    id: string,
    command: 'activate' | 'close' | 'cancel',
    body: unknown,
  ) {
    parse(z.object({}).strict(), body ?? {});
    const before = await this.get(identity.organizationId, id);
    const from = command === 'close' ? 'ACTIVE' : 'DRAFT';
    const status =
      command === 'activate'
        ? 'ACTIVE'
        : command === 'close'
          ? 'CLOSED'
          : 'CANCELLED';
    if (before.status !== from)
      throw new ConflictException('Invalid recall lifecycle transition');
    if (command === 'activate') await this.refs.scope(before, identity);
    const result = await this.unique(() =>
      this.db.$transaction(async (tx) => {
        const changed = await tx.recall.updateMany({
          where: { id, organizationId: identity.organizationId, status: from },
          data: {
            status,
            ...(status === 'ACTIVE'
              ? { initiatedAt: new Date() }
              : status === 'CLOSED'
                ? { closedAt: new Date() }
                : {}),
          },
        });
        if (changed.count !== 1)
          throw new ConflictException('Recall changed concurrently');
        const row = await tx.recall.findFirstOrThrow({
          where: { id, organizationId: identity.organizationId },
        });
        await enqueueEvent(
          tx,
          eventSchema.parse({
            eventId: randomUUID(),
            eventType: `recall.${command === 'activate' ? 'activated' : command === 'close' ? 'closed' : 'cancelled'}`,
            eventVersion: 1,
            organizationId: row.organizationId,
            aggregateType: 'recall',
            aggregateId: row.id,
            producer: 'recall-service',
            occurredAt: row.updatedAt.toISOString(),
            payload: {
              productId: row.productId,
              ...(row.gtinId ? { gtinId: row.gtinId } : {}),
              ...(row.batchId ? { batchId: row.batchId } : {}),
              disposition:
                status === 'ACTIVE' ? 'recalled' : status.toLowerCase(),
              metadata: {
                recallId: row.id,
                recallNumber: row.recallNumber,
                title: row.title,
                reason: row.reason,
                severity: row.severity,
              },
            },
          }),
        );
        return row;
      }),
    );
    try {
      await this.cache?.invalidateOrganization(identity.organizationId);
    } catch {
      this.cache?.degraded(identity.organizationId);
    }
    return result;
  }
  private async unique<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'Recall number or active recall scope already exists',
        );
      throw error;
    }
  }
}
