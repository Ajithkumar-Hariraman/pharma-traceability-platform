import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { InternalIdentityGuard } from './authorization';
import { BatchService } from './batch.service';
import type { BatchReference } from '@pharma/contracts';
@Controller('internal/organizations/:organizationId/batches/:batchId')
@UseGuards(InternalIdentityGuard)
export class BatchReferenceController {
  constructor(private readonly service: BatchService) {}
  @Get('validation') async validate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<BatchReference> {
    const batch = await this.service.get(organizationId, batchId);
    return {
      organizationId: batch.organizationId,
      productId: batch.productId,
      gtinId: batch.gtinId,
      batchId: batch.id,
      status: batch.status,
    };
  }
}
