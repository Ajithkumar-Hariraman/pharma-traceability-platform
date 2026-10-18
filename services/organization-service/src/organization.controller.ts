import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { OrganizationService } from './organization.service';
import {
  InternalIdentityGuard,
  OrganizationGuard,
  AdminOnly,
  type InternalRequest,
} from './authorization';
@Controller('organizations')
@UseGuards(InternalIdentityGuard, OrganizationGuard)
export class OrganizationController {
  constructor(private readonly service: OrganizationService) {}
  @Post() create(@Body() body: unknown, @Req() req: InternalRequest) {
    return this.service.create(body, req.userId);
  }
  @Get() list(@Req() req: InternalRequest) {
    return this.service.list(req.userId);
  }
  @Get(':organizationId') get(
    @Param('organizationId', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(id);
  }
  @Patch(':organizationId') @AdminOnly() update(
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.update(id, body);
  }
  @Post(':organizationId/facilities') @AdminOnly() createFacility(
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.createFacility(id, body);
  }
  @Get(':organizationId/facilities') facilities(
    @Param('organizationId', ParseUUIDPipe) id: string,
  ) {
    return this.service.facilities(id);
  }
  @Get(':organizationId/facilities/:facilityId') facility(
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Param('facilityId', ParseUUIDPipe) facilityId: string,
  ) {
    return this.service.facility(id, facilityId);
  }
  @Patch(':organizationId/facilities/:facilityId') @AdminOnly() updateFacility(
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Param('facilityId', ParseUUIDPipe) facilityId: string,
    @Body() body: unknown,
  ) {
    return this.service.updateFacility(id, facilityId, body);
  }
  @Get(':organizationId/access') access(
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Req() req: InternalRequest,
  ) {
    return this.service.access(id, req.userId);
  }
  @Get(':organizationId/memberships') memberships(
    @Param('organizationId', ParseUUIDPipe) id: string,
  ) {
    return this.service.memberships(id);
  }
}
