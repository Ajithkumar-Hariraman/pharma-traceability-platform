import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TraceService } from './trace.service';
import { TraceGuard, type TraceRequest } from './trace.guard';
@Controller('organizations/:organizationId/trace')
@UseGuards(TraceGuard)
export class TraceController {
  constructor(private readonly service: TraceService) {}
  @Get('events') list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: unknown,
  ) {
    return this.service.list(org, query);
  }
  @Get('events/:eventId') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('eventId') id: string,
  ) {
    return this.service.get(org, id);
  }
  @Get('serials/:id') serial(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return this.service.list(org, query, { serializedItemId: id });
  }
  @Get('batches/:id') batch(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return this.service.list(org, query, { batchId: id });
  }
  @Get('aggregates/:id') aggregate(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return this.service.list(org, query, { aggregateId: id });
  }
}
@Controller('internal/organizations/:organizationId/trace')
@UseGuards(TraceGuard)
export class CaptureController {
  constructor(private readonly service: TraceService) {}
  @Post('events') capture(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
    @Req() req: TraceRequest,
  ) {
    return this.service.capture(org, body, req.caller);
  }
}
