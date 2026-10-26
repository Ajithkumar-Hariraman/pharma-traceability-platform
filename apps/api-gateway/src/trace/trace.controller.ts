import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';
import { TraceProxy } from './trace-proxy';
@Controller('api/organizations/:organizationId/trace')
@UseGuards(GatewayIdentityGuard)
export class TraceController {
  constructor(private readonly service: TraceProxy) {}
  @Get('events') list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    return this.forward(org, 'events', query, req, res);
  }
  @Get('events/:eventId') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('eventId') id: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    return this.forward(org, `events/${encodeURIComponent(id)}`, {}, req, res);
  }
  @Get('serials/:id') serial(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    return this.forward(org, `serials/${id}`, query, req, res);
  }
  @Get('batches/:id') batch(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    return this.forward(org, `batches/${id}`, query, req, res);
  }
  @Get('aggregates/:id') aggregate(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    return this.forward(org, `aggregates/${id}`, query, req, res);
  }
  private forward(
    org: string,
    resource: string,
    query: Record<string, unknown>,
    req: AuthenticatedRequest,
    res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string')
        throw new BadRequestException('Invalid trace query');
      params.set(key, value);
    }
    const suffix = params.size ? `?${params}` : '';
    return this.service.forward(
      `/organizations/${org}/trace/${resource}${suffix}`,
      req.userId,
    );
  }
}
