import { Injectable } from '@nestjs/common';
import { PrismaService } from './persistence/prisma.service';
import type {
  Prisma,
  SerializedItem,
  SerializedItemStatus,
} from '../generated/client';
@Injectable()
export class SerializationRepository {
  constructor(private readonly prisma: PrismaService) {}
  page(organizationId: string, after?: string) {
    return this.prisma.serializedItem.findMany({
      where: { organizationId, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: 50,
    });
  }
  lookup(organizationId: string, gtinId: string, serialNumber: string) {
    return this.prisma.serializedItem.findFirst({
      where: { organizationId, gtinId, serialNumber },
    });
  }
  create(data: Prisma.SerializedItemUncheckedCreateInput) {
    return this.prisma.serializedItem.create({ data });
  }
  bulk(data: Prisma.SerializedItemCreateManyInput[]) {
    return this.prisma.$transaction((tx) =>
      tx.serializedItem.createManyAndReturn({ data }),
    );
  }
  list(organizationId: string, batchId: string) {
    return this.prisma.serializedItem.findMany({
      where: { organizationId, batchId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  find(organizationId: string, id: string) {
    return this.prisma.serializedItem.findFirst({
      where: { organizationId, id },
    });
  }
  transition(
    organizationId: string,
    id: string,
    from: SerializedItemStatus,
    to: SerializedItemStatus,
    afterMutation?: (
      tx: Prisma.TransactionClient,
      row: SerializedItem,
    ) => Promise<void>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const changed = await tx.serializedItem.updateMany({
        where: { organizationId, id, status: from },
        data: {
          status: to,
          ...(to === 'COMMISSIONED'
            ? { commissionedAt: now }
            : to === 'DECOMMISSIONED'
              ? { decommissionedAt: now }
              : {}),
        },
      });
      if (changed.count !== 1) return null;
      const row = await tx.serializedItem.findFirstOrThrow({
        where: { organizationId, id },
      });
      await afterMutation?.(tx, row);
      return row;
    });
  }
}
