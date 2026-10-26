import cors from 'cors';
import helmet from 'helmet';
import type { Express } from 'express';
import { createBaseApp, errorHandler, healthRouter, isMongoConnected, notFoundHandler, type Logger } from '@food/common';
import type { CatalogConfig } from './config.js';
import { restaurantsRouter } from './routes/restaurants.routes.js';
import { CatalogService } from './services/catalog.service.js';

export function createApp(
  config: CatalogConfig,
  logger: Logger,
  deps: { service?: CatalogService; isBrokerConnected?: () => boolean } = {},
): Express {
  const jwt = { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  const app = createBaseApp(logger);
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS === '*' ? '*' : config.CORS_ORIGINS.split(',') }));
  app.use(healthRouter('catalog-service', { mongo: isMongoConnected }, deps.isBrokerConnected ? { rabbitmq: deps.isBrokerConnected } : {}));
  app.use('/restaurants', restaurantsRouter(deps.service ?? new CatalogService(), jwt));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
