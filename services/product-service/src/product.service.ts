import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import { normalizeGtin, packagingLevels } from '@pharma/contracts';
import { ProductRepository } from './product.repository';
const status = z.enum(['ACTIVE', 'INACTIVE']);
const product = z
  .object({
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().max(4000).nullable().optional(),
    manufacturerName: z.string().trim().max(200).nullable().optional(),
    status: status.optional(),
  })
  .strict();
const gtin = z
  .object({
    gtin: z.string().transform((value, ctx) => {
      const normalized = normalizeGtin(value);
      if (!normalized) {
        ctx.addIssue({ code: 'custom', message: 'Invalid GTIN' });
        return z.NEVER;
      }
      return normalized;
    }),
    packagingLevel: z.enum(packagingLevels),
    status: status.optional(),
  })
  .strict();
const productPatch = product.partial().refine((v) => Object.keys(v).length > 0);
const gtinPatch = gtin.partial().refine((v) => Object.keys(v).length > 0);
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(
      'Invalid product or GTIN input. Check supported length, GS1 check digit, packaging level and status',
    );
  return result.data;
}
@Injectable()
export class ProductService {
  constructor(private readonly repository: ProductRepository) {}
  create(organizationId: string, body: unknown) {
    return this.repository.create({ organizationId, ...parse(product, body) });
  }
  list(organizationId: string) {
    return this.repository.list(organizationId);
  }
  async get(organizationId: string, id: string) {
    const row = await this.repository.find(organizationId, id);
    if (!row) throw new NotFoundException('Product not found');
    return row;
  }
  async update(organizationId: string, id: string, body: unknown) {
    await this.get(organizationId, id);
    return this.repository.update(
      organizationId,
      id,
      parse(productPatch, body),
    );
  }
  async gtins(organizationId: string, productId: string) {
    await this.get(organizationId, productId);
    return this.repository.gtins(organizationId, productId);
  }
  async gtin(organizationId: string, productId: string, id: string) {
    await this.get(organizationId, productId);
    const row = await this.repository.gtin(organizationId, productId, id);
    if (!row) throw new NotFoundException('GTIN not found');
    return row;
  }
  async createGtin(organizationId: string, productId: string, body: unknown) {
    await this.get(organizationId, productId);
    const data = parse(gtin, body);
    return this.unique(() =>
      this.repository.createGtin({ organizationId, productId, ...data }),
    );
  }
  async updateGtin(
    organizationId: string,
    productId: string,
    id: string,
    body: unknown,
  ) {
    await this.gtin(organizationId, productId, id);
    const data = parse(gtinPatch, body);
    return this.unique(() =>
      this.repository.updateGtin(organizationId, productId, id, data),
    );
  }
  private async unique<T>(op: () => Promise<T>) {
    try {
      return await op();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException('GTIN is already assigned');
      throw error;
    }
  }
}
