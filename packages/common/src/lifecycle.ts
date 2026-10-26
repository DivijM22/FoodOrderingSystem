import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Logger } from 'pino';

/**
 * Starts the HTTP server and wires graceful shutdown:
 * stop accepting connections, run cleanup hooks (in order), then exit.
 */
export function startServer(params: {
  app: Express;
  port: number;
  logger: Logger;
  onShutdown?: Array<() => Promise<void>>;
  /** Run before the server stops accepting connections, e.g. to end long-lived streams (SSE) that would block close. */
  beforeClose?: Array<() => Promise<void>>;
  shutdownTimeoutMs?: number;
}): Server {
  const { app, port, logger, onShutdown = [], beforeClose = [], shutdownTimeoutMs = 10_000 } = params;
  const server = app.listen(port, () => logger.info({ port }, 'HTTP server listening'));
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    const timer = setTimeout(() => {
      logger.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, shutdownTimeoutMs);
    timer.unref();

    for (const hook of beforeClose) await hook().catch((err) => logger.error({ err }, 'Shutdown hook failed'));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const hook of onShutdown) {
      try {
        await hook();
      } catch (err) {
        logger.error({ err }, 'Shutdown hook failed');
      }
    }
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  return server;
}
