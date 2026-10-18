import { Injectable } from '@nestjs/common';
import { PrismaService } from './persistence/prisma.service';
import type { Prisma, MembershipRole } from '../generated/client';
@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(legalName: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { legalName },
      });
      await tx.membership.create({
        data: { organizationId: organization.id, userId, role: 'ORG_ADMIN' },
      });
      return organization;
    });
  }
  list(userId: string) {
    return this.prisma.organization.findMany({
      where: { memberships: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
    });
  }
  find(id: string) {
    return this.prisma.organization.findUnique({ where: { id } });
  }
  membership(organizationId: string, userId: string) {
    return this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
  }
  update(id: string, data: Prisma.OrganizationUpdateInput) {
    return this.prisma.organization.update({ where: { id }, data });
  }
  facilities(organizationId: string) {
    return this.prisma.facility.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }
  facility(organizationId: string, id: string) {
    return this.prisma.facility.findFirst({ where: { id, organizationId } });
  }
  createFacility(data: Prisma.FacilityUncheckedCreateInput) {
    return this.prisma.facility.create({ data });
  }
  updateFacility(
    organizationId: string,
    id: string,
    data: Prisma.FacilityUpdateInput,
  ) {
    return this.prisma.facility.update({ where: { id, organizationId }, data });
  }
  memberships(organizationId: string) {
    return this.prisma.membership.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }
  async role(
    organizationId: string,
    userId: string,
  ): Promise<MembershipRole | undefined> {
    return (await this.membership(organizationId, userId))?.role;
  }
}
