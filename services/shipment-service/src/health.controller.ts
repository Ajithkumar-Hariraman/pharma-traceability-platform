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
      if (
        this.messaging.enabled &&
        (!this.prisma.outbox?.status().running ||
          !this.prisma.outbox.status().storageAvailable)
      )
        throw new Error('Outbox publisher unavailable');
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        service: 'shipment-service',
        status: 'ok',
        database: 'ok',
        outbox: this.prisma.outbox?.status(),
      };
    } catch {
      throw new ServiceUnavailableException(
        'Shipment database or outbox unavailable',
      );
    }
  }
}
