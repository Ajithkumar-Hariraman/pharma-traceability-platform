import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@pharma/contracts';
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { service: 'api-gateway', status: 'ok' };
  }
}
