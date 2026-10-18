import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
@Injectable()
export class DatabaseRepository {
  constructor(private readonly prisma: PrismaService) {}
  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
