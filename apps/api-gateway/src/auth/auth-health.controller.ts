import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@pharma/contracts';
import { AuthHealthService } from './auth-health.service';
@Controller('api/auth/health')
export class AuthHealthController {
  constructor(private readonly auth: AuthHealthService) {}
  @Get()
  getHealth(): Promise<HealthResponse> {
    return this.auth.check();
  }
}
