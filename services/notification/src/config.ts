import { z } from 'zod';
import { baseConfigSchema, loadConfig } from '@food/common';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Internal-only service: no JWTs (it exposes nothing but /health), so the JWT settings are not required. */
const schema = baseConfigSchema
  .omit({ JWT_SECRET: true, JWT_ISSUER: true, JWT_AUDIENCE: true })
  .extend({
    PORT: z.coerce.number().int().positive().default(4006),
    RABBITMQ_URL: z.string().min(1),
    EVENT_EXCHANGE: z.string().default('food.events'),
    /** SMTP: Mailpit locally (no credentials). Real providers via the same variables. */
    SMTP_HOST: z.string().default('mailpit'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: bool.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    MAIL_FROM: z.string().default('FoodApp <no-reply@food.local>'),
    APP_NAME: z.string().default('FoodApp'),
    NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
    SENDER_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
    /** A claimed send not finished within this time is assumed lost (crash) and retried. */
    SEND_LEASE_MS: z.coerce.number().int().min(1000).default(60_000),
    /** X25519 private key (base64 PKCS#8 DER) for opening delivery codes. Without it the restricted consumer is not started. */
    NOTIFICATION_OTP_PRIVATE_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(40).optional()),
  });

export type NotificationConfig = z.infer<typeof schema>;
export const loadNotificationConfig = (env: NodeJS.ProcessEnv = process.env): NotificationConfig => loadConfig(schema, env);
