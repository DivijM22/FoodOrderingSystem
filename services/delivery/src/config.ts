import { z } from 'zod';
import { baseConfigSchema, loadConfig } from '@food/common';

const ms = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const schema = baseConfigSchema.extend({
  PORT: z.coerce.number().int().positive().default(4007),
  CORS_ORIGINS: z.string().default('*'),
  RABBITMQ_URL: z.string().min(1),
  EVENT_EXCHANGE: z.string().default('food.events'),
  OUTBOX_POLL_INTERVAL_MS: ms(1000, 50),

  /** Simulated restaurant preparation time after the order is confirmed. */
  PREPARATION_DELAY_MS: ms(15_000),
  /** Simulated time to find a partner once the food is ready (per attempt). */
  ASSIGNMENT_DELAY_MS: ms(5_000),
  /** Wait between assignment attempts while no partner is available. */
  ASSIGNMENT_RETRY_MS: ms(10_000, 100),
  /** Bounded retries: give up (delivery.assignment_failed) after this many attempts or this long, whichever first. */
  ASSIGNMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(60),
  ASSIGNMENT_TIMEOUT_MS: ms(10 * 60_000, 1000),
  /** How often the scheduler looks for due preparation/assignment work (state lives in MongoDB). */
  WORKER_INTERVAL_MS: ms(1000, 50),

  /** Delivery OTP: HMAC key for the stored verifier (never stored next to the data). */
  OTP_HMAC_KEY: z.string().min(32, 'OTP_HMAC_KEY must be at least 32 characters'),
  /** X25519 public key (base64 SPKI DER) of the Notification Service; OTPs are sealed to it. */
  NOTIFICATION_OTP_PUBLIC_KEY: z.string().min(40),
  OTP_TTL_MS: ms(5 * 60_000, 1000),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** Total OTPs per delivery (first + reissues) and the minimum gap between them. */
  OTP_MAX_ISSUES: z.coerce.number().int().min(1).max(10).default(3),
  OTP_RESEND_COOLDOWN_MS: ms(30_000),
});

export type DeliveryConfig = z.infer<typeof schema>;
export const loadDeliveryConfig = (env: NodeJS.ProcessEnv = process.env): DeliveryConfig => loadConfig(schema, env);
