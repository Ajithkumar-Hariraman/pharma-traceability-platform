import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { DocumentProxy } from './document-proxy';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';
@Controller('api/organizations/:organizationId/:domain/:domainId/documents')
@UseGuards(GatewayIdentityGuard)
export class DocumentController {
  constructor(private readonly proxy: DocumentProxy) {}
  private forward(
    req: AuthenticatedRequest,
    res: { setHeader(name: string, value: string): unknown },
    org: string,
    domain: string,
    id: string,
    suffix: string,
    body?: unknown,
  ) {
    if (!['products', 'recalls', 'shipments'].includes(domain))
      throw new BadRequestException('Invalid domain');
    res.setHeader('Cache-Control', 'no-store');
    return this.proxy.forward(
      req.method,
      `/organizations/${org}/${domain}/${id}/documents${suffix}`,
      req.userId,
      body,
    );
  }
  @Get('') list(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domain') domain: string,
    @Param('domainId', ParseUUIDPipe) id: string,
  ) {
    return this.forward(req, res, org, domain, id, '');
  }
  @Post('uploads') upload(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domain') domain: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.forward(req, res, org, domain, id, '/uploads', body);
  }
  @Post(':documentId/finalize') finalize(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domain') domain: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) document: string,
  ) {
    return this.forward(req, res, org, domain, id, `/${document}/finalize`);
  }
  @Get(':documentId/download') download(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domain') domain: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) document: string,
  ) {
    return this.forward(req, res, org, domain, id, `/${document}/download`);
  }
  @Delete(':documentId') delete(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domain') domain: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) document: string,
  ) {
    return this.forward(req, res, org, domain, id, `/${document}`);
  }
}
