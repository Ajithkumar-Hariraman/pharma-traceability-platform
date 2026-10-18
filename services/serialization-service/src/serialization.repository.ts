import { Injectable } from '@nestjs/common';
import { PrismaService } from './persistence/prisma.service';
import type { Prisma, SerializedItemStatus } from '../generated/client';
@Injectable()
export class SerializationRepository {
  constructor(private readonly prisma: PrismaService) {}
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
      return tx.serializedItem.findFirst({ where: { organizationId, id } });
    });
  }
}
