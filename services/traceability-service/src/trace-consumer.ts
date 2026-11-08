import { Injectable } from '@nestjs/common';
import { Messaging } from '@pharma/messaging';
import { TraceService } from './trace.service';
@Injectable()
export class TraceConsumer {
  constructor(
    private readonly messaging: Messaging,
    private readonly trace: TraceService,
  ) {}
  async onApplicationBootstrap() {
    await this.messaging.consume((event) => this.trace.consume(event));
  }
}
