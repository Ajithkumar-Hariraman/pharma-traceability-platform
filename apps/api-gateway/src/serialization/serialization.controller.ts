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
import { SerializationProxy } from './serialization-proxy';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';
@Controller('api/organizations/:organizationId')
@UseGuards(GatewayIdentityGuard)
export class SerializationController {
  constructor(private readonly service: SerializationProxy) {}
  @Post('batches/:batchId/serials') create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/batches/${batchId}/serials`,
      req.userId,
      body,
    );
  }
  @Get('batches/:batchId/serials') list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/batches/${batchId}/serials`,
      req.userId,
    );
  }
  @Post('batches/:batchId/serials/bulk') bulk(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/batches/${batchId}/serials/bulk`,
      req.userId,
      body,
    );
  }
  @Get('serials/:serialId') get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/serials/${serialId}`,
      req.userId,
    );
  }
  @Patch('serials/:serialId') patch(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/serials/${serialId}`,
      req.userId,
      body,
    );
  }
  @Post('serials/:serialId/commission') commission(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/serials/${serialId}/commission`,
      req.userId,
      body,
    );
  }
  @Post('serials/:serialId/decommission') decommission(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/serials/${serialId}/decommission`,
      req.userId,
      body,
    );
  }
  @Post('serials/:serialId/quarantine') quarantine(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('serialId', ParseUUIDPipe) serialId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${organizationId}/serials/${serialId}/quarantine`,
      req.userId,
      body,
    );
  }
}
