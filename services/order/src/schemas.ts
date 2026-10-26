import { z } from 'zod';
import { ORDER_STATUSES } from './models/order-status.js';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const deliveryAddress = z
  .object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().max(80).optional(),
    pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Pincode must be a valid 6-digit Indian PIN'),
    landmark: z.string().trim().max(120).optional(),
  })
  .strict();

/** Note: no prices or totals are accepted from the client — they are always computed server-side. */
export const createOrderBody = z
  .object({
    restaurantId: objectId,
    items: z
      .array(z.object({ menuItemId: objectId, quantity: z.number().int().min(1).max(20) }).strict())
      .min(1, 'Order must contain at least one item')
      .max(30),
    deliveryAddress,
    notes: z.string().trim().max(300).optional(),
    /** Optional promo code. Not validated here: the Billing Service decides whether it applies. */
    discountCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/, 'Discount codes are 3–20 letters/digits').optional(),
  })
  .strict();
export type CreateOrderInput = z.infer<typeof createOrderBody>;

export const idempotencyKeyHeader = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const orderIdParams = z.object({ id: objectId });

export const listOrdersQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  restaurantId: objectId.optional(),
  customerId: objectId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuery>;

export const cancelOrderBody = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
