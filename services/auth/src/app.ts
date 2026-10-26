import cors from 'cors';
import helmet from 'helmet';
import type { Express } from 'express';
import { createBaseApp, errorHandler, healthRouter, isMongoConnected, notFoundHandler, type Logger } from '@food/common';
import type { AuthConfig } from './config.js';
import { authRouter } from './routes/auth.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { AuthService } from './services/auth.service.js';

export function createApp(
  config: AuthConfig,
  logger: Logger,
  deps: { onEventsCommitted?: () => void; isBrokerConnected?: () => boolean } = {},
): { app: Express; service: AuthService } {
  const jwt = { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  const service = new AuthService({ jwt: { ...jwt, expiresIn: config.JWT_EXPIRES_IN }, bcryptRounds: config.BCRYPT_ROUNDS, onEventsCommitted: deps.onEventsCommitted });

  const app = createBaseApp(logger);
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS === '*' ? '*' : config.CORS_ORIGINS.split(',') }));
  // RabbitMQ is optional for health: deactivation events wait safely in the outbox while it is down.
  app.use(healthRouter('auth-service', { mongo: isMongoConnected }, { rabbitmq: deps.isBrokerConnected ?? (() => false) }));
  app.use('/auth', authRouter(service, jwt));
  app.use('/auth/users', usersRouter(service, jwt));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return { app, service };
}
