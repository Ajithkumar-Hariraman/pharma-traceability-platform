import { Injectable } from '@nestjs/common';
import { PrismaService } from './persistence/prisma.service';
import type { Prisma } from '../generated/client';
@Injectable()
export class BatchRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(data: Prisma.BatchUncheckedCreateInput) {
    return this.prisma.batch.create({ data });
  }
  list(organizationId: string, productId?: string, gtinId?: string) {
    return this.prisma.batch.findMany({
      where: { organizationId, productId, gtinId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  find(organizationId: string, id: string) {
    return this.prisma.batch.findFirst({ where: { organizationId, id } });
  }
  update(organizationId: string, id: string, data: Prisma.BatchUpdateInput) {
    return this.prisma.batch.update({ where: { organizationId, id }, data });
  }
}
