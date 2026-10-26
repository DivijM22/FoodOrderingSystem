import cors from 'cors';
import helmet from 'helmet';
import type { Express } from 'express';
import { createBaseApp, errorHandler, healthRouter, isMongoConnected, notFoundHandler, type Logger } from '@food/common';
import type { PaymentConfig } from './config.js';
import { paymentsRouter } from './routes/payments.routes.js';
import { PaymentService } from './services/payment.service.js';
import type { PaymentWorkflow } from './services/workflow.js';

export interface AppDeps {
  workflow: PaymentWorkflow;
  kick?: () => void;
  isBrokerConnected?: () => boolean;
}

export function createApp(config: PaymentConfig, logger: Logger, deps: AppDeps): Express {
  const jwt = { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  const service = new PaymentService(deps.workflow, deps.kick);

  // Raw body capture is required for Stripe signature verification.
  const app = createBaseApp(logger, { captureRawBody: true });
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS === '*' ? '*' : config.CORS_ORIGINS.split(',') }));
  app.use(healthRouter('payment-service', { mongo: isMongoConnected }, { rabbitmq: deps.isBrokerConnected ?? (() => false) }));
  app.use(
    '/payments',
    paymentsRouter({ service, workflow: deps.workflow, jwt, logger, enableTestEndpoints: config.ENABLE_TEST_ENDPOINTS }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
