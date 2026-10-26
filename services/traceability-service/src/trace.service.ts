import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { traceEventTypes, traceActions } from '@pharma/contracts';
import { PrismaService } from './persistence/prisma.service';
import { Prisma } from '../generated/client';
const uuid = z.string().uuid();
const optionalId = uuid.nullish().transform((v) => v ?? null);
export const captureSchema = z
  .object({
    organizationId: uuid,
    eventId: z.string().trim().min(1).max(200),
    eventType: z.enum(traceEventTypes),
    action: z.enum(traceActions),
    eventTime: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    businessStep: z
      .string()
      .min(1)
      .max(200)
      .nullish()
      .transform((v) => v ?? null),
    disposition: z
      .string()
      .min(1)
      .max(200)
      .nullish()
      .transform((v) => v ?? null),
    facilityId: optionalId,
    productId: optionalId,
    gtinId: optionalId,
    batchId: optionalId,
    serializedItemId: optionalId,
    aggregateContainerId: optionalId,
    childContainerId: optionalId,
    parentEventId: optionalId,
    metadata: z
      .record(z.string(), z.json())
      .nullish()
      .transform((v) => v ?? null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.eventType === 'OBJECT' &&
      (!v.serializedItemId || !v.batchId || !v.productId || !v.gtinId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Object event requires trusted serial relationships',
      });
    if (
      v.eventType === 'AGGREGATION' &&
      (!v.aggregateContainerId || !!v.serializedItemId === !!v.childContainerId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Aggregation requires parent and exactly one child',
      });
  });
export const querySchema = z
  .object({
    eventType: z.enum(traceEventTypes).optional(),
    action: z.enum(traceActions).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    serializedItemId: uuid.optional(),
    batchId: uuid.optional(),
    aggregateId: uuid.optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to),
    'Invalid date range',
  );
function canonical(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
@Injectable()
export class TraceService {
  constructor(private readonly db: PrismaService) {}
  async capture(organizationId: string, body: unknown, caller: string) {
    const parsed = captureSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid trace event');
    const data = parsed.data;
    if (data.organizationId !== organizationId)
      throw new BadRequestException('Organization mismatch');
    if (
      !['serialization-service', 'aggregation-service'].includes(caller) ||
      (caller === 'serialization-service' && data.eventType !== 'OBJECT') ||
      (caller === 'aggregation-service' && data.eventType !== 'AGGREGATION')
    )
      throw new BadRequestException('Caller cannot capture this event type');
    const existing = await this.db.traceEvent.findUnique({
      where: { eventId: data.eventId },
    });
    const compare = (row: typeof existing) => {
      if (
        !row ||
        canonical(captureSchema.parse(rowToInput(row))) !== canonical(data)
      )
        throw new ConflictException('Conflicting eventId');
      return row;
    };
    if (existing) return compare(existing);
    if (
      data.parentEventId &&
      !(await this.db.traceEvent.findFirst({
        where: { id: data.parentEventId, organizationId },
      }))
    )
      throw new BadRequestException('Parent event not found');
    try {
      return await this.db.traceEvent.create({
        data: {
          ...data,
          metadata:
            data.metadata === null
              ? Prisma.DbNull
              : (data.metadata as Prisma.InputJsonObject),
        },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'P2002'
      )
        return compare(
          await this.db.traceEvent.findUnique({
            where: { eventId: data.eventId },
          }),
        );
      throw error;
    }
  }
  async get(organizationId: string, eventId: string) {
    const row = await this.db.traceEvent.findFirst({
      where: { organizationId, eventId },
    });
    if (!row) throw new NotFoundException('Trace event not found');
    return row;
  }
  async list(
    organizationId: string,
    query: unknown,
    scope: Record<string, string> = {},
  ) {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid trace filters');
    const q = parsed.data;
    const where: Prisma.TraceEventWhereInput = {
      organizationId,
      eventType: q.eventType,
      action: q.action,
      serializedItemId: scope.serializedItemId ?? q.serializedItemId,
      batchId: scope.batchId ?? q.batchId,
      eventTime: {
        gte: q.from ? new Date(q.from) : undefined,
        lte: q.to ? new Date(q.to) : undefined,
      },
    };
    const aggregate = scope.aggregateId ?? q.aggregateId;
    if (aggregate)
      where.OR = [
        { aggregateContainerId: aggregate },
        { childContainerId: aggregate },
      ];
    const [items, total] = await this.db.$transaction(
      [
        this.db.traceEvent.findMany({
          where,
          orderBy: [{ eventTime: 'asc' }, { recordTime: 'asc' }, { id: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        this.db.traceEvent.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
function rowToInput(row: Record<string, unknown>) {
  const value = { ...row };
  delete value.id;
  delete value.recordTime;
  delete value.createdAt;
  if (value.eventTime instanceof Date)
    value.eventTime = value.eventTime.toISOString();
  return value;
}
