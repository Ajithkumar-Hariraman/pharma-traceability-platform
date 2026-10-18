import { Injectable } from '@nestjs/common';
import { PrismaService } from './persistence/prisma.service';
import type { Prisma } from '../generated/client';
@Injectable()
export class ProductRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(data: Prisma.ProductUncheckedCreateInput) {
    return this.prisma.product.create({ data });
  }
  list(organizationId: string) {
    return this.prisma.product.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  find(organizationId: string, id: string) {
    return this.prisma.product.findFirst({ where: { id, organizationId } });
  }
  update(organizationId: string, id: string, data: Prisma.ProductUpdateInput) {
    return this.prisma.product.update({ where: { id, organizationId }, data });
  }
  gtins(organizationId: string, productId: string) {
    return this.prisma.gTIN.findMany({
      where: { organizationId, productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  gtin(organizationId: string, productId: string, id: string) {
    return this.prisma.gTIN.findFirst({
      where: { id, organizationId, productId },
    });
  }
  createGtin(data: Prisma.GTINUncheckedCreateInput) {
    return this.prisma.gTIN.create({ data });
  }
  updateGtin(
    organizationId: string,
    productId: string,
    id: string,
    data: Prisma.GTINUpdateInput,
  ) {
    return this.prisma.gTIN.update({
      where: { id, organizationId, productId },
      data,
    });
  }
}
