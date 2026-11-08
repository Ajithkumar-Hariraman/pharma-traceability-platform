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
  @Post('verification') verify(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: unknown,
    @Req() req: InternalRequest,
  ) {
    return this.verification.verify({ ...req, organizationId }, body);
  }
}
