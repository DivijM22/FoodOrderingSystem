import cors from 'cors';
import helmet from 'helmet';
import type { Express } from 'express';
import { createBaseApp, errorHandler, healthRouter, isMongoConnected, notFoundHandler, type Logger } from '@food/common';
import type { DeliveryConfig } from './config.js';
import { deliveriesRouter } from './routes/deliveries.routes.js';
import type { DeliveryService } from './services/delivery.service.js';

export function createApp(
  config: Pick<DeliveryConfig, 'JWT_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE' | 'CORS_ORIGINS'>,
  logger: Logger,
  deps: { delivery: DeliveryService; isBrokerConnected?: () => boolean },
): Express {
  const jwt = { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  const app = createBaseApp(logger);
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS === '*' ? '*' : config.CORS_ORIGINS.split(',') }));
  app.use(healthRouter('delivery-service', { mongo: isMongoConnected }, { rabbitmq: deps.isBrokerConnected ?? (() => false) }));
  app.use('/deliveries', deliveriesRouter(deps.delivery, jwt));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
