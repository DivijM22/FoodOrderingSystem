import { z } from 'zod';
import { baseConfigSchema, loadConfig } from '@food/common';

const schema = baseConfigSchema.extend({
  PORT: z.coerce.number().int().positive().default(4005),
  CORS_ORIGINS: z.string().default('*'),
  RABBITMQ_URL: z.string().min(1),
  EVENT_EXCHANGE: z.string().default('food.events'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  /** A discount never reduces the payable amount below this (paise). Stripe's INR minimum is ₹0.50. */
  MIN_PAYABLE_AMOUNT: z.coerce.number().int().min(50).default(100),
  /** Seed the sample discount codes on startup (idempotent; never overwrites edits). */
  SEED_DISCOUNTS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

export type BillingConfig = z.infer<typeof schema>;
export const loadBillingConfig = (env: NodeJS.ProcessEnv = process.env): BillingConfig => loadConfig(schema, env);
