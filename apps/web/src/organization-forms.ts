import { z } from 'zod';
export const organizationSchema = z.object({
  legalName: z.string().trim().min(2, 'Enter at least two characters').max(200),
});
export const facilitySchema = z.object({
  name: z.string().trim().min(2, 'Enter at least two characters').max(200),
  type: z.enum(['MANUFACTURER', 'DISTRIBUTOR', 'WHOLESALER', 'DISPENSER']),
  gln: z
    .string()
    .refine(
      (value) => value === '' || /^\d{13}$/.test(value),
      'GLN must contain exactly 13 digits',
    ),
});
export type OrganizationForm = z.infer<typeof organizationSchema>;
export type FacilityForm = z.infer<typeof facilitySchema>;
