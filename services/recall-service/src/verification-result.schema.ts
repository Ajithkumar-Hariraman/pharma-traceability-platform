import { z } from 'zod';
import { verificationResults } from '@pharma/contracts';
export const cachedVerificationSchema = z
  .object({
    result: z.enum(verificationResults),
    gtin: z.string(),
    serialNumber: z.string(),
    verifiedAt: z.iso.datetime(),
    explanation: z.string().min(1).max(4000),
    productName: z.string().max(1000).optional(),
    lotNumber: z.string().max(1000).optional(),
    expiryDate: z.iso.date().nullable().optional(),
    recall: z
      .object({
        recallNumber: z.string(),
        title: z.string(),
        reason: z.string(),
        severity: z.enum(['CLASS_I', 'CLASS_II', 'CLASS_III']),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.result === 'VALID' && (!v.productName || !v.lotNumber || v.recall))
      ctx.addIssue({ code: 'custom', message: 'Invalid valid-result facts' });
  });
