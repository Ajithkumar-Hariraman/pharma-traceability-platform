import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { BatchProxy } from './batch-proxy';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';
@Controller('api/organizations/:organizationId')
@UseGuards(GatewayIdentityGuard)
export class BatchController {
  constructor(private readonly service: BatchProxy) {}
  @Post('products/:productId/gtins/:gtinId/batches') create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('gtinId', ParseUUIDPipe) gtinId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/products/${productId}/gtins/${gtinId}/batches`,
      req.userId,
      body,
    );
  }
  @Get('products/:productId/gtins/:gtinId/batches') gtinBatches(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('gtinId', ParseUUIDPipe) gtinId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/products/${productId}/gtins/${gtinId}/batches`,
      req.userId,
    );
  }
  @Get('batches') list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/batches`,
      req.userId,
    );
  }
  @Get('batches/:batchId') get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/batches/${batchId}`,
      req.userId,
    );
  }
  @Patch('batches/:batchId') update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/batches/${batchId}`,
      req.userId,
      body,
    );
  }
}
