import { z } from 'zod';
import { normalizeSerialNumber, MAX_BULK_SERIALS } from '@pharma/contracts';
const serialNumber = z
  .string()
  .refine(
    (value) => normalizeSerialNumber(value) !== null,
    'Enter a non-empty serial of at most 100 characters without control characters',
  );
export const serialSchema = z.object({ serialNumber });
export function serialLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
export const bulkSerialSchema = z.object({
  lines: z.string().refine((value) => {
    const serials = serialLines(value);
    return (
      serials.length > 0 &&
      serials.length <= MAX_BULK_SERIALS &&
      serials.every((serial) => normalizeSerialNumber(serial) !== null) &&
      new Set(serials).size === serials.length
    );
  }, 'Enter 1–100 distinct serials, one per line, up to 100 characters each'),
});
export type SerialForm = z.infer<typeof serialSchema>;
export type BulkSerialForm = z.infer<typeof bulkSerialSchema>;
