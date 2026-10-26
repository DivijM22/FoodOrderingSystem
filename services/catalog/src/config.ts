import { z } from 'zod';
import { baseConfigSchema, loadConfig } from '@food/common';

const schema = baseConfigSchema.extend({
  PORT: z.coerce.number().int().positive().default(4002),
  CORS_ORIGINS: z.string().default('*'),
  RABBITMQ_URL: z.string().min(1).default('amqp://unused'),
  EVENT_EXCHANGE: z.string().default('food.events'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  /** Anti-entropy: re-broadcast all restaurant snapshots this often (repairs missed events). */
  CATALOG_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  /** Seed sample restaurants on startup. Seeding is idempotent and never overwrites edits. */
  SEED_ON_START: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type CatalogConfig = z.infer<typeof schema>;
export const loadCatalogConfig = (env: NodeJS.ProcessEnv = process.env): CatalogConfig => loadConfig(schema, env);
