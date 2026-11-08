import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { RecallProxy } from './recall-proxy';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';
@Controller('api/organizations/:organizationId')
@UseGuards(GatewayIdentityGuard)
export class RecallController {
  constructor(private readonly service: RecallProxy) {}
  @Get('recalls') list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string')
        throw new BadRequestException('Invalid recall filters');
      params.set(key, value);
    }
    const suffix = params.size ? `?${params}` : '';
    return this.service.forward(
      'GET',
      `/organizations/${org}/recalls${suffix}`,
      req.userId,
    );
  }
  @Get('recalls/:recallId') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('recallId', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      'GET',
      `/organizations/${org}/recalls/${id}`,
      req.userId,
    );
  }
  @Post('recalls') create(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      'POST',
      `/organizations/${org}/recalls`,
      req.userId,
      body,
    );
  }
  @Post('recalls/:recallId/:command') command(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('recallId', ParseUUIDPipe) id: string,
    @Param('command') command: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['activate', 'close', 'cancel'].includes(command))
      throw new BadRequestException('Invalid recall command');
    return this.service.forward(
      'POST',
      `/organizations/${org}/recalls/${id}/${command}`,
      req.userId,
      body,
    );
  }
  @Post('verification') verify(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      'POST',
      `/organizations/${org}/verification`,
      req.userId,
      body,
      res,
    );
  }
}
