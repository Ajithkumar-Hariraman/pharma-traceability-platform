import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { BatchService } from './batch.service';
import { InternalIdentityGuard, type InternalRequest } from './authorization';
@Controller('organizations/:organizationId')
@UseGuards(InternalIdentityGuard)
export class BatchController {
  constructor(private readonly service: BatchService) {}
  @Post('products/:productId/gtins/:gtinId/batches') create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('gtinId', ParseUUIDPipe) gtinId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.create(
      organizationId,
      productId,
      gtinId,
      body,
      req.userId,
      req.role,
    );
  }
  @Get('products/:productId/gtins/:gtinId/batches') gtinBatches(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('gtinId', ParseUUIDPipe) gtinId: string,
    @Req() req: InternalRequest,
  ) {
    return this.service.listForGtin(
      organizationId,
      productId,
      gtinId,
      req.userId,
      req.role,
    );
  }
  @Get('batches') list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.service.list(organizationId);
  }
  @Get('batches/:batchId') get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ) {
    return this.service.get(organizationId, batchId);
  }
  @Patch('batches/:batchId') update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.update(
      organizationId,
      batchId,
      body,
      req.userId,
      req.role,
    );
  }
}
