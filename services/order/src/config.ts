import { z } from 'zod';
import { baseConfigSchema, loadConfig } from '@food/common';

const schema = baseConfigSchema.extend({
  PORT: z.coerce.number().int().positive().default(4003),
  CORS_ORIGINS: z.string().default('*'),
  RABBITMQ_URL: z.string().min(1),
  EVENT_EXCHANGE: z.string().default('food.events'),
  /** Flat provisional delivery fee in paise, waived at or above FREE_DELIVERY_THRESHOLD (paise). */
  DELIVERY_FEE: z.coerce.number().int().min(0).default(4000),
  FREE_DELIVERY_THRESHOLD: z.coerce.number().int().min(0).default(49900),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  /** Unpaid orders expire this long after creation (default 15 minutes). */
  ORDER_PAYMENT_DEADLINE_SECONDS: z.coerce.number().int().min(10).default(900),
  /** How often the expiration worker sweeps for overdue unpaid orders. */
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).default(15_000),
  EXPIRY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
});

export type OrderConfig = z.infer<typeof schema>;
export const loadOrderConfig = (env: NodeJS.ProcessEnv = process.env): OrderConfig => loadConfig(schema, env);
