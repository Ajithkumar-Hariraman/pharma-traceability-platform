import { z } from 'zod';
import { batchStatuses, validBatchDates } from '@pharma/contracts';
const optionalDate = z.union([z.literal(''), z.iso.date()]);
export const batchSchema = z
  .object({
    lotNumber: z.string().trim().min(1, 'Enter a lot number').max(200),
    manufactureDate: optionalDate,
    expiryDate: optionalDate,
    status: z.enum(batchStatuses),
  })
  .refine((value) => validBatchDates(value.manufactureDate, value.expiryDate), {
    path: ['expiryDate'],
    message: 'Expiry date must be after manufacture date',
  });
export type BatchForm = z.infer<typeof batchSchema>;
