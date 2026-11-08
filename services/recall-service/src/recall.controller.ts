import { VerificationCache } from './verification-cache';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
  Res,
  HttpException,
} from '@nestjs/common';
import { RecallService } from './recall.service';
import { VerificationService } from './verification.service';
import { InternalIdentityGuard, type InternalRequest } from './authorization';
@Controller('organizations/:organizationId')
@UseGuards(InternalIdentityGuard)
export class RecallController {
  constructor(
    private readonly recalls: RecallService,
    private readonly verification: VerificationService,
    private readonly cache: VerificationCache,
  ) {}
  @Post('recalls') create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.recalls.create({ ...req, organizationId }, body);
  }
  @Get('recalls') list(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: unknown,
  ) {
    return this.recalls.list(org, query);
  }
  @Get('recalls/:recallId') get(
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('recallId', ParseUUIDPipe) id: string,
  ) {
    return this.recalls.get(org, id);
  }
  @Post('recalls/:recallId/activate') activate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('recallId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.recalls.command(
      { ...req, organizationId },
      id,
      'activate',
      body,
    );
  }
  @Post('recalls/:recallId/close') close(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('recallId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.recalls.command({ ...req, organizationId }, id, 'close', body);
  }
  @Post('recalls/:recallId/cancel') cancel(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('recallId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.recalls.command({ ...req, organizationId }, id, 'cancel', body);
  }
  @Post('verification') async verify(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
    @Res({ passthrough: true })
    res: { setHeader(name: string, value: string): unknown },
  ) {
    const limit = await this.cache.limit(organizationId, req.userId);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      throw new HttpException(
        {
          statusCode: 429,
          message: 'Verification rate limit exceeded',
          retryAfter: limit.retryAfter,
        },
        429,
      );
    }
    return this.verification.verify({ ...req, organizationId }, body);
  }
}
