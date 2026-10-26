import { z } from 'zod';
import { baseConfigSchema, loadConfig } from '@food/common';

const schema = baseConfigSchema.extend({
  PORT: z.coerce.number().int().positive().default(4001),
  JWT_EXPIRES_IN: z.string().default('1h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  CORS_ORIGINS: z.string().default('*'),
  /** Optional bootstrap platform administrator, created on first boot if absent. */
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  ADMIN_NAME: z.string().default('Platform Admin'),
  /** RabbitMQ: Auth publishes auth.user.deactivated.v1 / auth.user.deleted.v1 through its transactional outbox and consumes delivery assignment events. */
  RABBITMQ_URL: z.string().min(1).default('amqp://unused'),
  EVENT_EXCHANGE: z.string().default('food.events'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
});

export type AuthConfig = z.infer<typeof schema>;
export const loadAuthConfig = (env: NodeJS.ProcessEnv = process.env): AuthConfig => loadConfig(schema, env);
