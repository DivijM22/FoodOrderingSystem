import { z } from 'zod';
import { baseConfigSchema, loadConfig } from '@food/common';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = baseConfigSchema
  .extend({
    PORT: z.coerce.number().int().positive().default(4004),
    CORS_ORIGINS: z.string().default('*'),
    RABBITMQ_URL: z.string().min(1),
    EVENT_EXCHANGE: z.string().default('food.events'),

    /** `stripe` = real Stripe test mode; `mock` = local simulated provider (never real money, never "verified Stripe"). */
    PAYMENT_PROVIDER: z.enum(['stripe', 'mock']).default('mock'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /** Optional API endpoint override, e.g. stripe-mock at http://localhost:12111 (tests only). */
    STRIPE_API_URL: z.url().optional(),
    MOCK_WEBHOOK_SECRET: z.string().min(16).default('whsec_mock_local_development_only'),
    MOCK_WEBHOOK_URL: z.url().optional(),

    /** Enables POST /payments/:id/simulate so payments can be completed without a frontend. Never in production. */
    ENABLE_TEST_ENDPOINTS: bool.default(false),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    /** Re-check Stripe for payments stuck in `processing` / refunds stuck `pending` after this long (lost-webhook safety net). */
    PROVIDER_POLL_AFTER_MS: z.coerce.number().int().positive().default(60_000),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  })
  .superRefine((c, ctx) => {
    if (c.PAYMENT_PROVIDER === 'stripe') {
      // Hard guarantee: this service only ever talks to Stripe in test mode.
      if (!c.STRIPE_SECRET_KEY || !/^(sk|rk)_test_/.test(c.STRIPE_SECRET_KEY)) {
        ctx.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'A Stripe TEST key (sk_test_… / rk_test_…) is required; live keys are refused' });
      }
      if (!c.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) {
        ctx.addIssue({ code: 'custom', path: ['STRIPE_WEBHOOK_SECRET'], message: 'STRIPE_WEBHOOK_SECRET (whsec_…) is required' });
      }
    }
  });

export type PaymentConfig = z.infer<typeof schema>;
export const loadPaymentConfig = (env: NodeJS.ProcessEnv = process.env): PaymentConfig => loadConfig(schema, env);
