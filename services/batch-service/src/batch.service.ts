import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  batchStatuses,
  validBatchDates,
  type OrganizationRole,
} from '@pharma/contracts';
import { BatchRepository } from './batch.repository';
import { ProductValidationClient } from './product-validation.client';
const schema = z
  .object({
    lotNumber: z.string().trim().min(1).max(200),
    manufactureDate: z.iso.date().nullable().optional(),
    expiryDate: z.iso.date().nullable().optional(),
    status: z.enum(batchStatuses).optional(),
  })
  .strict();
const patch = schema.partial().refine((value) => Object.keys(value).length > 0);
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(
      'Invalid batch input. Check lot number, ISO dates and status',
    );
  return result.data;
}
function date(value: string | null | undefined) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}
function dates(
  manufactureDate: string | null | undefined,
  expiryDate: string | null | undefined,
) {
  if (!validBatchDates(manufactureDate, expiryDate))
    throw new BadRequestException('Expiry date must be after manufacture date');
}
function serialize<
  T extends { manufactureDate: Date | null; expiryDate: Date | null },
>(row: T) {
  return {
    ...row,
    manufactureDate: row.manufactureDate?.toISOString().slice(0, 10) ?? null,
    expiryDate: row.expiryDate?.toISOString().slice(0, 10) ?? null,
  };
}
@Injectable()
export class BatchService {
  constructor(
    private readonly repository: BatchRepository,
    private readonly products: ProductValidationClient,
  ) {}
  async create(
    organizationId: string,
    productId: string,
    gtinId: string,
    body: unknown,
    userId: string,
    role: OrganizationRole,
  ) {
    const input = parse(schema, body);
    dates(input.manufactureDate, input.expiryDate);
    await this.products.validate(
      organizationId,
      productId,
      gtinId,
      userId,
      role,
    );
    return serialize(
      await this.unique(() =>
        this.repository.create({
          ...input,
          organizationId,
          productId,
          gtinId,
          manufactureDate: date(input.manufactureDate),
          expiryDate: date(input.expiryDate),
        }),
      ),
    );
  }
  async list(organizationId: string) {
    return (await this.repository.list(organizationId)).map(serialize);
  }
  async listForGtin(
    organizationId: string,
    productId: string,
    gtinId: string,
    userId: string,
    role: OrganizationRole,
  ) {
    await this.products.validate(
      organizationId,
      productId,
      gtinId,
      userId,
      role,
    );
    return (await this.repository.list(organizationId, productId, gtinId)).map(
      serialize,
    );
  }
  async get(organizationId: string, id: string) {
    const row = await this.repository.find(organizationId, id);
    if (!row) throw new NotFoundException('Batch not found');
    return serialize(row);
  }
  async update(
    organizationId: string,
    id: string,
    body: unknown,
    userId: string,
    role: OrganizationRole,
  ) {
    const input = parse(patch, body);
    const row = await this.get(organizationId, id);
    const manufactureDate =
      input.manufactureDate === undefined
        ? row.manufactureDate
        : input.manufactureDate;
    const expiryDate =
      input.expiryDate === undefined ? row.expiryDate : input.expiryDate;
    dates(manufactureDate, expiryDate);
    await this.products.validate(
      organizationId,
      row.productId,
      row.gtinId,
      userId,
      role,
    );
    // Write the validated date pair together; the database check also protects concurrent writes.
    return serialize(
      await this.unique(() =>
        this.repository.update(organizationId, id, {
          ...input,
          manufactureDate: date(manufactureDate),
          expiryDate: date(expiryDate),
        }),
      ),
    );
  }
  private async unique<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException('Lot number already exists for this GTIN');
      throw error;
    }
  }
}
