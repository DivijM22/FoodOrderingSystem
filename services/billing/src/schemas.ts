import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
export const invoiceIdParams = z.object({ id: objectId });
export const orderIdParams = z.object({ orderId: objectId });
export const listQuery = z.object({
  orderId: objectId.optional(),
  customerId: objectId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/);
export const codeParams = z.object({ code });
export const createDiscountBody = z
  .object({
    code,
    description: z.string().trim().min(3).max(120),
    type: z.enum(['percent', 'flat']),
    value: z.number().int().min(1),
    maxDiscount: z.number().int().min(1).optional(),
    minItemsSubtotal: z.number().int().min(0).default(0),
    active: z.boolean().default(true),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
  })
  .strict()
  .refine((d) => d.type !== 'percent' || d.value <= 100, { message: 'Percent discounts must be 1–100', path: ['value'] });
export const setActiveBody = z.object({ active: z.boolean() }).strict();
