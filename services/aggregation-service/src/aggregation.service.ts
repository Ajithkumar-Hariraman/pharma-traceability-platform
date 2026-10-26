import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  canAggregate,
  aggregatePackagingLevels,
  type OrganizationRole,
} from '@pharma/contracts';
import { PrismaService } from './persistence/prisma.service';
import { Prisma } from '../generated/client';
import { SerialValidationClient } from './serial-validation.client';
const createSchema = z
  .object({
    containerCode: z.string().trim().min(1).max(100),
    packagingLevel: z.enum(aggregatePackagingLevels),
  })
  .strict();
@Injectable()
export class AggregationService {
  constructor(
    private readonly db: PrismaService,
    private readonly serials: SerialValidationClient,
  ) {}
  async create(organizationId: string, body: unknown) {
    const input = createSchema.safeParse(body);
    if (!input.success)
      throw new BadRequestException(
        'Container code and packaging level are required',
      );
    try {
      return await this.db.aggregateContainer.create({
        data: { organizationId, ...input.data },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Container code already exists');
      throw error;
    }
  }
  list(organizationId: string) {
    return this.db.aggregateContainer.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }
  async get(organizationId: string, id: string) {
    const row = await this.db.aggregateContainer.findFirst({
      where: { organizationId, id },
    });
    if (!row) throw new NotFoundException('Container not found');
    return row;
  }
  async parent(organizationId: string, childSerializedItemId: string) {
    const relation = await this.db.aggregationRelation.findFirst({
      where: { organizationId, childSerializedItemId },
      include: { parent: true },
    });
    return relation?.parent ?? null;
  }
  async hierarchy(
    organizationId: string,
    id: string,
    userId: string,
    role: OrganizationRole,
  ) {
    await this.get(organizationId, id);
    // One repeatable snapshot prevents a move from appearing twice in the tree.
    const [containers, relations] = await this.db.$transaction(
      [
        this.db.aggregateContainer.findMany({ where: { organizationId } }),
        this.db.aggregationRelation.findMany({ where: { organizationId } }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    const build = async (
      containerId: string,
      depth: number,
    ): Promise<unknown> => {
      if (depth > 2) throw new ConflictException('Invalid hierarchy');
      const row = containers.find((c) => c.id === containerId);
      if (!row) throw new ConflictException('Hierarchy changed; retry');
      const children = relations.filter(
        (r) => r.parentContainerId === containerId,
      );
      return {
        ...row,
        children: await Promise.all(
          children
            .filter((r) => r.childContainerId)
            .map((r) => build(r.childContainerId!, depth + 1)),
        ),
        items: await Promise.all(
          children
            .filter((r) => r.childSerializedItemId)
            .map((r) =>
              this.serials.validate(
                organizationId,
                r.childSerializedItemId!,
                userId,
                role,
              ),
            ),
        ),
      };
    };
    return build(id, 0);
  }
  async change(
    organizationId: string,
    parentId: string,
    type: 'items' | 'containers',
    childId: string,
    remove: boolean,
    userId: string,
    role: OrganizationRole,
  ) {
    const reference =
      type === 'items' && !remove
        ? await this.serials.validate(organizationId, childId, userId, role)
        : null;
    if (reference && reference.status !== 'COMMISSIONED')
      throw new ConflictException('Serialized item must be COMMISSIONED');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.$transaction(
          async (tx) => {
            // Serialize packaging mutations per tenant, including removal and parent status checks.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 8))::text`;
            const parent = await tx.aggregateContainer.findFirst({
              where: { id: parentId, organizationId },
            });
            if (!parent) throw new NotFoundException('Container not found');
            const child =
              type === 'containers'
                ? await tx.aggregateContainer.findFirst({
                    where: { id: childId, organizationId },
                  })
                : null;
            if (type === 'containers' && !child)
              throw new NotFoundException('Child container not found');
            const source =
              type === 'items'
                ? { childSerializedItemId: childId }
                : { childContainerId: childId };
            if (remove) {
              const result = await tx.aggregationRelation.deleteMany({
                where: {
                  organizationId,
                  parentContainerId: parentId,
                  ...source,
                },
              });
              if (!result.count)
                throw new NotFoundException('Relationship not found');
              return { removed: true };
            }
            if (parent.status !== 'ACTIVE')
              throw new ConflictException('Parent container must be ACTIVE');
            if (parentId === childId)
              throw new ConflictException('Self-parenting is forbidden');
            if (child && child.status !== 'ACTIVE')
              throw new ConflictException('Child container must be ACTIVE');
            if (
              !canAggregate(
                child?.packagingLevel ?? 'EACH',
                parent.packagingLevel,
              )
            )
              throw new ConflictException(
                'Invalid packaging transition or cycle',
              );
            // Strictly increasing packaging ranks make cycles impossible.
            const existing = await tx.aggregationRelation.findFirst({
              where: { organizationId, ...source },
            });
            if (existing)
              throw new ConflictException(
                'Child already has a parent; disaggregate before moving',
              );
            return tx.aggregationRelation.create({
              data: {
                organizationId,
                parentContainerId: parentId,
                childType: type === 'items' ? 'SERIALIZED_ITEM' : 'CONTAINER',
                ...source,
              },
            });
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === 'P2034') {
            if (attempt < 2) continue;
            throw new ServiceUnavailableException(
              'Concurrent packaging update; retry',
            );
          }
          if (error.code === 'P2002')
            throw new ConflictException('Child already has a parent');
        }
        throw error;
      }
    }
  }
}
