import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  Query,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import { ShipmentService } from './shipment.service';
import { InternalIdentityGuard, type InternalRequest } from './authorization';
@Controller('organizations/:organizationId/shipments')
@UseGuards(InternalIdentityGuard)
export class ShipmentController {
  constructor(private readonly service: ShipmentService) {}
  @Post() create(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.service.create(org, body, req.userId, req.role);
  }
  @Get() list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: unknown,
  ) {
    return this.service.list(org, query);
  }
  @Get(':id') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(org, id);
  }
  @Post(':id/:command') command(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('command') command: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    if (command === 'items' || command === 'containers') {
      const parsed = z
        .object({ referenceId: z.string().uuid() })
        .strict()
        .safeParse(body);
      if (!parsed.success)
        throw new BadRequestException('Invalid reference ID');
      return this.service.change(
        org,
        id,
        command,
        parsed.data.referenceId,
        false,
        req.userId,
        req.role,
      );
    }
    return this.service.transition(org, id, command, req.userId, req.role);
  }
  @Delete(':id/:kind/:referenceId') remove(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Param('referenceId', ParseUUIDPipe) ref: string,
    @Req() req: InternalRequest,
  ) {
    if (kind !== 'items' && kind !== 'containers')
      throw new BadRequestException('Invalid content kind');
    return this.service.change(org, id, kind, ref, true, req.userId, req.role);
  }
}
