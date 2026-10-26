import { z } from 'zod';
import { PAYMENT_STATUSES } from './models/payment-status.js';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

/** Only the order id is accepted — amount and currency always come from the Order Service. */
export const initiateBody = z.object({ orderId: objectId }).strict();

export const paymentIdParams = z.object({ id: objectId });
export const orderIdParams = z.object({ orderId: objectId });

export const listQuery = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  orderId: objectId.optional(),
  customerId: objectId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const refundBody = z
  .object({
    /** Optional partial amount in paise; defaults to the full remaining amount. */
    amount: z.number().int('Amounts are integer paise').min(100, 'Minimum refund is ₹1').optional(),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const idempotencyKeyHeader = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const simulateBody = z
  .object({
    outcome: z.enum(['succeed', 'fail', 'succeed_refund_fails', 'processing']),
    /** Mock provider only: deliver the resulting webhook this many times (duplicate-delivery demo). */
    deliveries: z.number().int().min(1).max(5).default(1),
  })
  .strict();
