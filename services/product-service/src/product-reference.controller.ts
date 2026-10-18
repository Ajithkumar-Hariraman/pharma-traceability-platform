import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { InternalIdentityGuard } from './authorization';
import { ProductService } from './product.service';
import type { ProductReference } from '@pharma/contracts';
@Controller(
  'internal/organizations/:organizationId/products/:productId/gtins/:gtinId',
)
@UseGuards(InternalIdentityGuard)
export class ProductReferenceController {
  constructor(private readonly service: ProductService) {}
  @Get('validation') async validate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('gtinId', ParseUUIDPipe) gtinId: string,
  ): Promise<ProductReference> {
    await this.service.gtin(organizationId, productId, gtinId);
    return { organizationId, productId, gtinId };
  }
}
