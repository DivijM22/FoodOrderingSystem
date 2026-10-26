import cors from 'cors';
import helmet from 'helmet';
import type { Express } from 'express';
import { createBaseApp, errorHandler, healthRouter, isMongoConnected, notFoundHandler, type Logger } from '@food/common';
import type { CatalogGateway } from './catalog/catalog.gateway.js';
import type { OrderConfig } from './config.js';
import { ordersRouter } from './routes/orders.routes.js';
import { OrderService } from './services/order.service.js';
import { TrackingHub } from './tracking/tracking.js';

export interface AppDeps {
  catalog: CatalogGateway;
  /** Notified after commits that wrote outbox events (wired to OutboxRelay.kick). */
  onEventsCommitted?: () => void;
  isBrokerConnected?: () => boolean;
  /** SSE fan-out; created here when not supplied (the server passes one so it can close it on shutdown). */
  tracking?: TrackingHub;
}

export function createApp(config: OrderConfig, logger: Logger, deps: AppDeps): Express {
  const jwt = { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  const service = new OrderService(
    deps.catalog,
    { deliveryFee: config.DELIVERY_FEE, freeDeliveryThreshold: config.FREE_DELIVERY_THRESHOLD },
    deps.onEventsCommitted,
    config.ORDER_PAYMENT_DEADLINE_SECONDS,
  );

  const app = createBaseApp(logger);
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS === '*' ? '*' : config.CORS_ORIGINS.split(',') }));
  // RabbitMQ is optional for health: while it is down, events wait safely in the outbox.
  app.use(healthRouter('order-service', { mongo: isMongoConnected }, { rabbitmq: deps.isBrokerConnected ?? (() => false) }));
  app.use('/orders', ordersRouter(service, jwt, deps.tracking ?? new TrackingHub(logger.child({ component: 'tracking' }))));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
