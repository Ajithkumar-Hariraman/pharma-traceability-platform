import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './persistence/prisma.service';
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('health') health() {
    return { service: 'traceability-service', status: 'ok' };
  }
  @Get('ready') async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { service: 'traceability-service', status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException(
        'Traceability database unavailable',
      );
    }
  }
}
