import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import { AggregationService } from './aggregation.service';
import { InternalIdentityGuard, type InternalRequest } from './authorization';
@Controller('organizations/:organizationId')
@UseGuards(InternalIdentityGuard)
export class AggregationController {
  constructor(private readonly service: AggregationService) {}
  @Post('aggregates') create(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
  ) {
    return this.service.create(org, body);
  }
  @Get('aggregates') list(@Param('organizationId', ParseUUIDPipe) org: string) {
    return this.service.list(org);
  }
  @Get('aggregates/:id') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(org, id);
  }
  @Get('aggregates/:id/hierarchy') hierarchy(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: InternalRequest,
  ) {
    return this.service.hierarchy(org, id, req.userId, req.role);
  }
  @Get('serials/:id/parent') parent(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.parent(org, id);
  }
  @Post('aggregates/:id/items') additems(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: InternalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ serializedItemId: z.string().uuid() })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid child identifier');
    const childId = parsed.data.serializedItemId;
    return this.service.change(
      org,
      id,
      'items',
      childId,
      false,
      req.userId,
      req.role,
    );
  }
  @Delete('aggregates/:id/items/:childId') removeitems(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: InternalRequest,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.service.change(
      org,
      id,
      'items',
      childId,
      true,
      req.userId,
      req.role,
    );
  }
  @Post('aggregates/:id/containers') addcontainers(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: InternalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ childContainerId: z.string().uuid() })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid child identifier');
    const childId = parsed.data.childContainerId;
    return this.service.change(
      org,
      id,
      'containers',
      childId,
      false,
      req.userId,
      req.role,
    );
  }
  @Delete('aggregates/:id/containers/:childId') removecontainers(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: InternalRequest,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.service.change(
      org,
      id,
      'containers',
      childId,
      true,
      req.userId,
      req.role,
    );
  }
}
