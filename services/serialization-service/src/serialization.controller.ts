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
import { SerializationService } from './serialization.service';
import { InternalIdentityGuard, type InternalRequest } from './authorization';
@Controller('organizations/:organizationId')
@UseGuards(InternalIdentityGuard)
export class SerializationController {
  constructor(private readonly service: SerializationService) {}
  @Post('batches/:batchId/serials') create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.create(
      organizationId,
      batchId,
      body,
      req.userId,
      req.role,
    );
  }
  @Get('batches/:batchId/serials') list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Req() req: InternalRequest,
  ) {
    return this.service.list(organizationId, batchId, req.userId, req.role);
  }
  @Post('batches/:batchId/serials/bulk') bulk(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.bulk(
      organizationId,
      batchId,
      body,
      req.userId,
      req.role,
    );
  }
  @Get('serials/:serialId') get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
  ) {
    return this.service.get(organizationId, serialId);
  }
  @Patch('serials/:serialId') patch(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
  ) {
    return this.service.patch(organizationId, serialId);
  }
  @Post('serials/:serialId/commission') commission(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.command(
      organizationId,
      serialId,
      'commission',
      body,
      req.userId,
      req.role,
    );
  }
  @Post('serials/:serialId/decommission') decommission(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.command(
      organizationId,
      serialId,
      'decommission',
      body,
      req.userId,
      req.role,
    );
  }
  @Post('serials/:serialId/quarantine') quarantine(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.command(
      organizationId,
      serialId,
      'quarantine',
      body,
      req.userId,
      req.role,
    );
  }
}
