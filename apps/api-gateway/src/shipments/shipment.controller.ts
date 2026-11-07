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
import { ShipmentProxy } from './shipment-proxy';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';
@Controller('api/organizations/:organizationId/shipments')
@UseGuards(GatewayIdentityGuard)
export class ShipmentController {
  constructor(private readonly service: ShipmentProxy) {}
  @Get() list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string')
        throw new BadRequestException('Invalid shipment filters');
      params.set(key, value);
    }
    return this.service.forward(
      'GET',
      `/organizations/${org}/shipments${params.size ? '?' + params.toString() : ''}`,
      req.userId,
    );
  }
  @Post() create(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.forward(
      'POST',
      `/organizations/${org}/shipments`,
      req.userId,
      body,
    );
  }
  @Get(':id') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.forward(
      'GET',
      `/organizations/${org}/shipments/${id}`,
      req.userId,
    );
  }
  @Post(':id/:command') command(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('command') command: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    if (
      ![
        'items',
        'containers',
        'ready',
        'dispatch',
        'in-transit',
        'receive',
        'cancel',
      ].includes(command)
    )
      throw new BadRequestException('Invalid shipment command');
    return this.service.forward(
      'POST',
      `/organizations/${org}/shipments/${id}/${command}`,
      req.userId,
      body,
    );
  }
  @Delete(':id/:kind/:ref') remove(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Param('ref', ParseUUIDPipe) ref: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (kind !== 'items' && kind !== 'containers')
      throw new BadRequestException('Invalid content kind');
    return this.service.forward(
      'DELETE',
      `/organizations/${org}/shipments/${id}/${kind}/${ref}`,
      req.userId,
    );
  }
}
