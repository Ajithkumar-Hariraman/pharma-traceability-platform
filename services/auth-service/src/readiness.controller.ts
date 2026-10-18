import { Controller, Get } from '@nestjs/common';
import { ReadinessService } from './readiness.service';
@Controller('ready')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}
  @Get()
  getReadiness() {
    return this.readiness.check();
  }
}
