import { z } from 'zod';
import { DELIVERY_STATUSES } from '@food/common';

const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

export const deliveryIdParams = z.object({ id: objectId });
export const orderIdParams = z.object({ orderId: objectId });
export const listQuery = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
/** Agent identity comes from the JWT; the body never names an agent. */
export const upsertAgentBody = z
  .object({ phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10–15 digits').optional(), available: z.boolean().optional() })
  .strict();
export const agentsQuery = z.object({ status: z.enum(['available', 'busy', 'offline']).optional() });
export const verifyOtpBody = z.object({ otp: z.string().regex(/^\d{6}$/, 'The code has 6 digits') }).strict();
