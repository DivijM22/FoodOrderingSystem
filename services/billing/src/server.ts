import { connectMongo, createLogger, disconnectMongo, MessageBroker, OutboxRelay, startServer } from '@food/common';
import { createApp } from './app.js';
import { loadBillingConfig } from './config.js';
import { subscribeBillingEvents } from './consumers/events.js';
import { seedDiscounts } from './seed/discounts.js';
import { BillingService } from './services/billing.service.js';

const config = loadBillingConfig();
const logger = createLogger('billing-service', config.LOG_LEVEL);

async function main() {
  await connectMongo(config.MONGO_URI, logger);
  if (config.SEED_DISCOUNTS) logger.info({ inserted: await seedDiscounts() }, 'Discount codes seeded');

  const broker = new MessageBroker({ url: config.RABBITMQ_URL, exchange: config.EVENT_EXCHANGE, logger });
  await broker.connect();
  const relay = new OutboxRelay(broker, logger.child({ component: 'outbox-relay' }), { pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS });
  relay.start();

  const billing = new BillingService(logger.child({ component: 'billing' }), { minPayable: config.MIN_PAYABLE_AMOUNT }, () => relay.kick());
  void subscribeBillingEvents(broker, billing, logger.child({ component: 'events' })).catch((err) => logger.error({ err }, 'Failed to subscribe to events'));

  const app = createApp(config, logger, {
    billing,
    isBrokerConnected: () => broker.isConnected(),
  });
  startServer({ app, port: config.PORT, logger, onShutdown: [() => relay.stop(), () => broker.close(), disconnectMongo] });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start billing-service');
  process.exit(1);
});
