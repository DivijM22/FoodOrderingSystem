import type { Express } from 'express';
import { createBaseApp, errorHandler, healthRouter, isMongoConnected, notFoundHandler, type Logger } from '@food/common';

/** Internal-only: exposes nothing but /health (not routed through the API gateway). */
export function createApp(logger: Logger, deps: { isBrokerConnected?: () => boolean; isSmtpReachable?: () => boolean; hasOtpKey?: () => boolean }): Express {
  const app = createBaseApp(logger);
  app.use(
    healthRouter(
      'notification-service',
      { mongo: isMongoConnected },
      { rabbitmq: deps.isBrokerConnected ?? (() => false), smtp: deps.isSmtpReachable ?? (() => false), otpKey: deps.hasOtpKey ?? (() => false) },
    ),
  );
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
