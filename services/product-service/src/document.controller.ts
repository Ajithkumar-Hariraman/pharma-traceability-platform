import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  ParseUUIDPipe,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Documents, ObjectStorage } from '@pharma/object-storage';
import { PrismaService } from './persistence/prisma.service';
import { ProductService } from './product.service';
import { InternalIdentityGuard, type InternalRequest } from './authorization';
@Controller('organizations/:organizationId/products/:domainId/documents')
@UseGuards(InternalIdentityGuard)
export class DocumentController implements OnModuleInit, OnModuleDestroy {
  private readonly documents: Documents;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(db: PrismaService, owner: ProductService, config: ConfigService) {
    this.documents = new Documents(
      db.document,
      new ObjectStorage(
        config.get<Record<string, unknown>>('storage') ?? process.env,
      ),
      'PRODUCT',
      (org, id) => owner.get(org, id),
    );
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.documents
        .cleanup()
        .catch(() => undefined)
        .finally(() => {
          this.running = false;
        });
    }, 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  @Get() list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domainId', ParseUUIDPipe) id: string,
  ) {
    return this.documents.list(org, id);
  }
  @Post('uploads') upload(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Req() req: InternalRequest,
    @Body() body: unknown,
  ) {
    return this.documents.upload(
      org,
      id,
      req.userId,
      req.headers['x-identity-role']!,
      body,
    );
  }
  @Post(':documentId/finalize') finalize(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) document: string,
    @Req() req: InternalRequest,
  ) {
    return this.documents.finalize(
      org,
      id,
      document,
      req.headers['x-identity-role']!,
    );
  }
  @Get(':documentId/download') download(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) document: string,
  ) {
    return this.documents.download(org, id, document);
  }
  @Delete(':documentId') delete(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('domainId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) document: string,
    @Req() req: InternalRequest,
  ) {
    return this.documents.delete(
      org,
      id,
      document,
      req.headers['x-identity-role']!,
    );
  }
}
