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
} from '@nestjs/common';
import { AggregationProxy } from './aggregation-proxy';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';
@Controller('api/organizations/:organizationId')
@UseGuards(GatewayIdentityGuard)
export class AggregationController {
  constructor(private readonly service: AggregationProxy) {}
  @Post('aggregates') create(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates`,
      req.userId,
      body,
    );
  }
  @Get('aggregates') list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates`,
      req.userId,
    );
  }
  @Get('aggregates/:id') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates/${id}`,
      req.userId,
    );
  }
  @Get('aggregates/:id/hierarchy') hierarchy(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates/${id}/hierarchy`,
      req.userId,
    );
  }
  @Get('serials/:id/parent') parent(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/serials/${id}/parent`,
      req.userId,
    );
  }
  @Post('aggregates/:id/items') additems(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates/${id}/items`,
      req.userId,
      body,
    );
  }
  @Delete('aggregates/:id/items/:childId') removeitems(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates/${id}/items/${childId}`,
      req.userId,
    );
  }
  @Post('aggregates/:id/containers') addcontainers(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates/${id}/containers`,
      req.userId,
      body,
    );
  }
  @Delete('aggregates/:id/containers/:childId') removecontainers(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.service.forward(
      req.method,
      `/organizations/${org}/aggregates/${id}/containers/${childId}`,
      req.userId,
    );
  }
}
