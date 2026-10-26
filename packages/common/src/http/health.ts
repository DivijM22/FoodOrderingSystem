import { Router } from 'express';

export type HealthCheck = () => boolean | Promise<boolean>;

async function run(checks: Record<string, HealthCheck>) {
  const results: Record<string, 'up' | 'down'> = {};
  for (const [name, check] of Object.entries(checks)) {
    try {
      results[name] = (await check()) ? 'up' : 'down';
    } catch {
      results[name] = 'down';
    }
  }
  return results;
}

/**
 * GET /health, used by Docker/ECS health checks and the gateway.
 * - critical checks down  → 503 "unhealthy" (orchestrator should restart/replace the task)
 * - optional checks down  → 200 "degraded" (service still works, e.g. events buffer in the outbox)
 */
export function healthRouter(
  service: string,
  critical: Record<string, HealthCheck>,
  optional: Record<string, HealthCheck> = {},
): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const [crit, opt] = await Promise.all([run(critical), run(optional)]);
    const healthy = Object.values(crit).every((s) => s === 'up');
    const degraded = Object.values(opt).some((s) => s === 'down');
    res.status(healthy ? 200 : 503).json({
      status: !healthy ? 'unhealthy' : degraded ? 'degraded' : 'ok',
      service,
      uptimeSeconds: Math.round(process.uptime()),
      checks: { ...crit, ...opt },
      timestamp: new Date().toISOString(),
    });
  });
  return router;
}
