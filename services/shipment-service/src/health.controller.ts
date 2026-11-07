import { Messaging } from '@pharma/messaging';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './persistence/prisma.service';
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: Messaging,
  ) {}
  @Get('health') health() {
    return { service: 'shipment-service', status: 'ok' };
  }
  @Get('ready') async ready() {
    try {
      await this.messaging.ready();
      await this.prisma.$queryRaw`SELECT 1`;
      return { service: 'shipment-service', status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException(
        'Shipment database or messaging unavailable',
      );
    }
  }
}
