import { connectMongo, createLogger, disconnectMongo, MessageBroker, OutboxRelay, startServer } from '@food/common';
import { createApp } from './app.js';
import { loadAuthConfig } from './config.js';
import { subscribeDeliveryEvents } from './consumers/delivery-events.js';

const config = loadAuthConfig();
const logger = createLogger('auth-service', config.LOG_LEVEL);

async function main() {
  await connectMongo(config.MONGO_URI, logger);
  const broker = new MessageBroker({ url: config.RABBITMQ_URL, exchange: config.EVENT_EXCHANGE, logger });
  await broker.connect();
  const relay = new OutboxRelay(broker, logger.child({ component: 'outbox-relay' }), { pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS });
  relay.start();

  const { app, service } = createApp(config, logger, { onEventsCommitted: () => relay.kick(), isBrokerConnected: () => broker.isConnected() });
  void subscribeDeliveryEvents(broker, service, logger.child({ component: 'delivery-events' })).catch((err) =>
    logger.error({ err }, 'Failed to subscribe to delivery events'),
  );

  if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
    const created = await service.ensureAdmin({ email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD, name: config.ADMIN_NAME });
    if (created) logger.info({ email: config.ADMIN_EMAIL }, 'Bootstrap platform admin created');
  }

  startServer({ app, port: config.PORT, logger, onShutdown: [() => relay.stop(), () => broker.close(), disconnectMongo] });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start auth-service');
  process.exit(1);
});
