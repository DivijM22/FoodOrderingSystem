import cors from 'cors';
import helmet from 'helmet';
import type { Express } from 'express';
import { createBaseApp, errorHandler, healthRouter, isMongoConnected, notFoundHandler, type Logger } from '@food/common';
import type { BillingConfig } from './config.js';
import { discountsRouter, invoicesRouter } from './routes/billing.routes.js';
import type { BillingService } from './services/billing.service.js';

export function createApp(
  config: BillingConfig,
  logger: Logger,
  deps: { billing: BillingService; isBrokerConnected?: () => boolean },
): Express {
  const jwt = { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  const app = createBaseApp(logger);
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS === '*' ? '*' : config.CORS_ORIGINS.split(',') }));
  app.use(healthRouter('billing-service', { mongo: isMongoConnected }, { rabbitmq: deps.isBrokerConnected ?? (() => false) }));
  app.use('/invoices', invoicesRouter(deps.billing, jwt));
  app.use('/discounts', discountsRouter(deps.billing, jwt));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
