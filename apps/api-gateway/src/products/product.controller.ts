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
import { ProductProxy } from './product-proxy';
import {
  GatewayIdentityGuard,
  type AuthenticatedRequest,
} from '../organizations/organization-proxy';

@Controller('api/organizations/:organizationId/products')
@UseGuards(GatewayIdentityGuard)
export class ProductController {
  constructor(private readonly service: ProductProxy) {}
  @Post('') create(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products`,
      req.userId,
      body,
    );
  }
  @Get('') list(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products`,
      req.userId,
    );
  }
  @Get(':productId') get(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products/${product}`,
      req.userId,
    );
  }
  @Patch(':productId') update(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Body() body: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products/${product}`,
      req.userId,
      body,
    );
  }
  @Post(':productId/gtins') createGtin(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Body() body: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products/${product}/gtins`,
      req.userId,
      body,
    );
  }
  @Get(':productId/gtins') gtins(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products/${product}/gtins`,
      req.userId,
    );
  }
  @Get(':productId/gtins/:gtinId') gtin(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Param('gtinId', ParseUUIDPipe) gtin: string,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products/${product}/gtins/${gtin}`,
      req.userId,
    );
  }
  @Patch(':productId/gtins/:gtinId') updateGtin(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: import('express').Response,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Param('gtinId', ParseUUIDPipe) gtin: string,
    @Body() body: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.forward(
      req.method,
      `/organizations/${org}/products/${product}/gtins/${gtin}`,
      req.userId,
      body,
    );
  }
}
