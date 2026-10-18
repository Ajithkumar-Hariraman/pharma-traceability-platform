import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import { OrganizationRepository } from './organization.repository';
const status = z.enum(['ACTIVE', 'INACTIVE']);
const organization = z
  .object({ legalName: z.string().trim().min(2).max(200) })
  .strict();
const organizationPatch = organization
  .extend({ status })
  .partial()
  .refine((value) => Object.keys(value).length > 0);
const facility = z
  .object({
    name: z.string().trim().min(2).max(200),
    type: z.enum(['MANUFACTURER', 'DISTRIBUTOR', 'WHOLESALER', 'DISPENSER']),
    gln: z
      .string()
      .regex(/^\d{13}$/)
      .nullable()
      .optional(),
  })
  .strict();
const facilityPatch = facility
  .extend({ status })
  .partial()
  .refine((value) => Object.keys(value).length > 0);
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(
      'Invalid input. Check names, facility type, status, and 13-digit GLN',
    );
  return result.data;
}
@Injectable()
export class OrganizationService {
  constructor(private readonly repository: OrganizationRepository) {}
  create(body: unknown, userId: string) {
    return this.repository.create(parse(organization, body).legalName, userId);
  }
  list(userId: string) {
    return this.repository.list(userId);
  }
  async get(id: string) {
    const result = await this.repository.find(id);
    if (!result) throw new NotFoundException('Organization not found');
    return result;
  }
  async update(id: string, body: unknown) {
    await this.get(id);
    return this.repository.update(id, parse(organizationPatch, body));
  }
  facilities(id: string) {
    return this.repository.facilities(id);
  }
  async facility(id: string, facilityId: string) {
    const result = await this.repository.facility(id, facilityId);
    if (!result) throw new NotFoundException('Facility not found');
    return result;
  }
  async createFacility(id: string, body: unknown) {
    return this.handleUnique(() =>
      this.repository.createFacility({
        organizationId: id,
        ...parse(facility, body),
      }),
    );
  }
  async updateFacility(id: string, facilityId: string, body: unknown) {
    await this.facility(id, facilityId);
    return this.handleUnique(() =>
      this.repository.updateFacility(
        id,
        facilityId,
        parse(facilityPatch, body),
      ),
    );
  }
  async access(organizationId: string, userId: string) {
    return {
      organizationId,
      userId,
      role: await this.repository.role(organizationId, userId),
    };
  }
  memberships(id: string) {
    return this.repository.memberships(id);
  }
  private async handleUnique<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'This GLN is already assigned to a facility',
        );
      throw error;
    }
  }
}
