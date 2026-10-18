import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ProductService } from './product.service';
import { InternalIdentityGuard } from './authorization';
@Controller('organizations/:organizationId/products')
@UseGuards(InternalIdentityGuard)
export class ProductController {
  constructor(private readonly service: ProductService) {}
  @Post('') create(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: unknown,
  ) {
    return this.service.create(org, body);
  }
  @Get('') list(@Param('organizationId', ParseUUIDPipe) org: string) {
    return this.service.list(org);
  }
  @Get(':productId') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
  ) {
    return this.service.get(org, product);
  }
  @Patch(':productId') update(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Body() body: unknown,
  ) {
    return this.service.update(org, product, body);
  }
  @Post(':productId/gtins') createGtin(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Body() body: unknown,
  ) {
    return this.service.createGtin(org, product, body);
  }
  @Get(':productId/gtins') gtins(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
  ) {
    return this.service.gtins(org, product);
  }
  @Get(':productId/gtins/:gtinId') gtin(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Param('gtinId', ParseUUIDPipe) gtin: string,
  ) {
    return this.service.gtin(org, product, gtin);
  }
  @Patch(':productId/gtins/:gtinId') updateGtin(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('productId', ParseUUIDPipe) product: string,
    @Param('gtinId', ParseUUIDPipe) gtin: string,
    @Body() body: unknown,
  ) {
    return this.service.updateGtin(org, product, gtin, body);
  }
}
