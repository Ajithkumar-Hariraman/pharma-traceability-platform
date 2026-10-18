import { z } from 'zod';
import { normalizeGtin, packagingLevels } from '@pharma/contracts';
export const productSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least two characters').max(200),
  description: z.string().trim().max(4000),
  manufacturerName: z.string().trim().max(200),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export const gtinSchema = z.object({
  gtin: z
    .string()
    .refine(
      (value) => normalizeGtin(value) !== null,
      'Enter a numeric GTIN of 8, 12, 13 or 14 digits with a valid GS1 check digit',
    ),
  packagingLevel: z.enum(packagingLevels),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export type ProductForm = z.infer<typeof productSchema>;
export type GtinForm = z.infer<typeof gtinSchema>;
