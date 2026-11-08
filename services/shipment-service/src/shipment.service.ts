import { enqueueEvent, fromTrace } from '@pharma/messaging';
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  shipmentStatuses,
  type OrganizationRole,
  type TraceCapture,
} from '@pharma/contracts';
import { PrismaService } from './persistence/prisma.service';
import { Prisma } from '../generated/client';
import { ReferenceClient } from './reference.client';
import { TraceCaptureClient } from './trace-capture.client';
const createSchema = z
  .object({
    shipmentNumber: z.string().trim().min(1).max(100),
    sourceFacilityId: z.string().uuid(),
    destinationFacilityId: z.string().uuid(),
  })
  .strict()
  .refine((v) => v.sourceFacilityId !== v.destinationFacilityId);
export const listSchema = z
  .object({
    status: z.enum(shipmentStatuses).optional(),
    sourceFacilityId: z.string().uuid().optional(),
    destinationFacilityId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export const transitions: Record<string, string[]> = {
  ready: ['CREATED'],
  dispatch: ['READY'],
  'in-transit': ['DISPATCHED'],
  receive: ['DISPATCHED', 'IN_TRANSIT'],
  cancel: ['CREATED', 'READY'],
};
const targets = {
  ready: 'READY',
  dispatch: 'DISPATCHED',
  'in-transit': 'IN_TRANSIT',
  receive: 'RECEIVED',
  cancel: 'CANCELLED',
} as const;
@Injectable()
export class ShipmentService {
  constructor(
    private readonly db: PrismaService,
    private readonly refs: ReferenceClient,
    private readonly trace: TraceCaptureClient,
  ) {}
  async create(
    org: string,
    body: unknown,
    user: string,
    role: OrganizationRole,
  ) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        'Shipment number and two different facility IDs are required',
      );
    await this.facilities(org, parsed.data, user, role);
    try {
      return await this.db.shipment.create({
        data: { organizationId: org, ...parsed.data },
        include: { contents: true },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw new ConflictException('Shipment number already exists');
      throw e;
    }
  }
  async facilities(
    org: string,
    row: { sourceFacilityId: string; destinationFacilityId: string },
    user: string,
    role: OrganizationRole,
  ) {
    await Promise.all([
      this.refs.validate(org, row.sourceFacilityId, 'facilities', user, role),
      this.refs.validate(
        org,
        row.destinationFacilityId,
        'facilities',
        user,
        role,
      ),
    ]);
  }
  async list(organizationId: string, query: unknown) {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException('Invalid shipment filters');
    const { page, pageSize, ...filters } = parsed.data;
    const where = { organizationId, ...filters };
    const [items, total] = await this.db.$transaction(
      [
        this.db.shipment.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.db.shipment.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return { items, total, page, pageSize };
  }
  async get(organizationId: string, id: string) {
    const row = await this.db.shipment.findFirst({
      where: { organizationId, id },
      include: { contents: true },
    });
    if (!row) throw new NotFoundException('Shipment not found');
    return row;
  }
  async locked<T>(
    org: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org}, 10))::text`;
        return fn(tx);
      },
      { timeout: 25000 },
    );
  }
  async change(
    org: string,
    id: string,
    kind: 'items' | 'containers',
    referenceId: string,
    remove: boolean,
    user: string,
    role: OrganizationRole,
  ) {
    if (!remove) await this.refs.validate(org, referenceId, kind, user, role);
    return this.locked(org, async (tx) => {
      const row = await tx.shipment.findFirst({
        where: { organizationId: org, id },
      });
      if (!row) throw new NotFoundException('Shipment not found');
      if (row.status !== 'CREATED')
        throw new ConflictException('Contents can only change while CREATED');
      const where = { organizationId: org, shipmentId: id, kind, referenceId };
      if (remove) {
        const result = await tx.shipmentContent.deleteMany({ where });
        if (!result.count)
          throw new NotFoundException('Shipment content not found');
        return { removed: true };
      }
      const existing = await tx.shipmentContent.findFirst({
        where: {
          organizationId: org,
          kind,
          referenceId,
          shipment: { status: { notIn: ['RECEIVED', 'CANCELLED'] } },
        },
      });
      if (existing)
        throw new ConflictException(
          'Reference already reserved in an open shipment',
        );
      if (
        (await tx.shipmentContent.count({
          where: { organizationId: org, shipmentId: id },
        })) >= 100
      )
        throw new ConflictException(
          'Shipment is limited to 100 direct references',
        );
      return tx.shipmentContent.create({ data: where });
    });
  }
  async transition(
    org: string,
    id: string,
    command: string,
    user: string,
    role: OrganizationRole,
  ) {
    if (!Object.hasOwn(targets, command))
      throw new BadRequestException('Unknown shipment command');
    const action = command as keyof typeof targets;
    const row = await this.locked(org, async (tx) => {
      const current = await tx.shipment.findFirst({
        where: { organizationId: org, id },
        include: { contents: true },
      });
      if (!current) throw new NotFoundException('Shipment not found');
      if (!transitions[action]!.includes(current.status))
        throw new ConflictException(
          `Cannot ${command} shipment in ${current.status}`,
        );
      if (action === 'ready' || action === 'dispatch') {
        if (!current.contents.length)
          throw new ConflictException(
            'Cannot ready or dispatch an empty shipment',
          );
        await this.facilities(org, current, user, role);
        for (let offset = 0; offset < current.contents.length; offset += 10) {
          await Promise.all(
            current.contents
              .slice(offset, offset + 10)
              .map((content) =>
                this.refs.validate(
                  org,
                  content.referenceId,
                  content.kind as 'items' | 'containers',
                  user,
                  role,
                ),
              ),
          );
        }
      }
      const result = await tx.shipment.update({
        where: { id },
        data: {
          status: targets[action],
          ...(action === 'dispatch'
            ? { dispatchedAt: new Date() }
            : action === 'receive'
              ? { receivedAt: new Date() }
              : action === 'cancel'
                ? { cancelledAt: new Date() }
                : {}),
        },
        include: { contents: true },
      });
      if (
        this.trace.outboxEnabled &&
        (action === 'dispatch' || action === 'receive')
      )
        await enqueueEvent(tx, fromTrace(this.shipmentEvent(result, action)));
      return result;
    });
    if (
      !this.trace.outboxEnabled &&
      (action === 'dispatch' || action === 'receive')
    )
      await this.trace.capture(this.shipmentEvent(row, action));
    return row;
  }
  private shipmentEvent(
    row: Prisma.ShipmentGetPayload<{ include: { contents: true } }>,
    action: 'dispatch' | 'receive',
  ): TraceCapture {
    return {
      organizationId: row.organizationId,
      eventId: `shipment:${row.id}:${action}`,
      eventType: 'TRANSACTION',
      action: 'OBSERVE',
      eventTime: (action === 'dispatch'
        ? row.dispatchedAt!
        : row.receivedAt!
      ).toISOString(),
      businessStep: action === 'dispatch' ? 'shipping' : 'receiving',
      facilityId:
        action === 'dispatch'
          ? row.sourceFacilityId
          : row.destinationFacilityId,
      metadata: {
        shipmentId: row.id,
        shipmentNumber: row.shipmentNumber,
        sourceFacilityId: row.sourceFacilityId,
        destinationFacilityId: row.destinationFacilityId,
        contents: row.contents.map((c) => ({
          kind: c.kind,
          referenceId: c.referenceId,
        })),
      },
    };
  }
}
