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
import type { Response } from 'express';
import {
  GatewayIdentityGuard,
  OrganizationProxy,
  type AuthenticatedRequest,
} from './organization-proxy';
@Controller('api/organizations')
@UseGuards(GatewayIdentityGuard)
export class OrganizationController {
  constructor(private readonly proxy: OrganizationProxy) {}
  private call(
    req: AuthenticatedRequest,
    res: Response,
    path: string,
    body?: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.proxy.forward(req.method, path, req.userId, body);
  }
  @Post() create(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return this.call(req, res, '/organizations', body);
  }
  @Get() list(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.call(req, res, '/organizations');
  }
  @Get(':organizationId') get(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('organizationId', ParseUUIDPipe) id: string,
  ) {
    return this.call(req, res, `/organizations/${id}`);
  }
  @Patch(':organizationId') update(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.call(req, res, `/organizations/${id}`, body);
  }
  @Post(':organizationId/facilities') createFacility(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.call(req, res, `/organizations/${id}/facilities`, body);
  }
  @Get(':organizationId/facilities') facilities(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('organizationId', ParseUUIDPipe) id: string,
  ) {
    return this.call(req, res, `/organizations/${id}/facilities`);
  }
  @Get(':organizationId/facilities/:facilityId') facility(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Param('facilityId', ParseUUIDPipe) facility: string,
  ) {
    return this.call(req, res, `/organizations/${id}/facilities/${facility}`);
  }
  @Patch(':organizationId/facilities/:facilityId') updateFacility(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Param('facilityId', ParseUUIDPipe) facility: string,
    @Body() body: unknown,
  ) {
    return this.call(
      req,
      res,
      `/organizations/${id}/facilities/${facility}`,
      body,
    );
  }
  @Get(':organizationId/memberships') memberships(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('organizationId', ParseUUIDPipe) id: string,
  ) {
    return this.call(req, res, `/organizations/${id}/memberships`);
  }
}
