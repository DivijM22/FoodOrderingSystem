import { connectMongo, createLogger, disconnectMongo, MessageBroker, OutboxRelay, startServer } from '@food/common';
import { createApp } from './app.js';
import { ProjectionCatalog } from './catalog/catalog.gateway.js';
import { CatalogProjectionModel, migrateProjectionOwnerIds } from './catalog/projection.model.js';
import { loadOrderConfig } from './config.js';
import { subscribeBillingEvents } from './consumers/billing-events.js';
import { requestCatalogSync, subscribeCatalogEvents } from './consumers/catalog-events.js';
import { subscribeDeliveryEvents } from './consumers/delivery-events.js';
import { subscribePaymentEvents } from './consumers/payment-events.js';
import { ExpirationWorker } from './services/expiration.worker.js';
import { TrackingHub } from './tracking/tracking.js';

const config = loadOrderConfig();
const logger = createLogger('order-service', config.LOG_LEVEL);

async function main() {
  await connectMongo(config.MONGO_URI, logger);
  // v1 projections stored a single ownerId; convert them to adminIds (idempotent).
  const migrated = await migrateProjectionOwnerIds();
  if (migrated) logger.info({ restaurants: migrated }, 'Migrated catalog projection ownerId to adminIds');

  const broker = new MessageBroker({ url: config.RABBITMQ_URL, exchange: config.EVENT_EXCHANGE, logger });
  await broker.connect();

  const relay = new OutboxRelay(broker, logger.child({ component: 'outbox-relay' }), { pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS });
  relay.start();
  const kick = () => relay.kick();
  const expiry = new ExpirationWorker(logger.child({ component: 'expiration-worker' }), kick, {
    intervalMs: config.EXPIRY_SWEEP_INTERVAL_MS,
    batchSize: config.EXPIRY_BATCH_SIZE,
  });
  expiry.start();

  const subscribe = (name: string, p: Promise<void>) => void p.catch((err) => logger.error({ err }, `Failed to subscribe to ${name}`));
  // Event-driven inputs (no synchronous calls to other services):
  subscribe('catalog events', subscribeCatalogEvents(broker, logger.child({ component: 'catalog-events' })));
  subscribe('payment events', subscribePaymentEvents(broker, logger.child({ component: 'payment-events' }), kick));
  subscribe('billing events', subscribeBillingEvents(broker, logger.child({ component: 'billing-events' })));
  subscribe('delivery events', subscribeDeliveryEvents(broker, logger.child({ component: 'delivery-events' }), kick));

  // Bootstrap the catalog read model: ask for snapshots while it is empty (the Catalog also re-broadcasts periodically).
  if ((await CatalogProjectionModel.estimatedDocumentCount()) === 0) {
    await requestCatalogSync('order-service started with an empty catalog read model');
    kick();
    logger.info('Requested catalog snapshot (read model empty)');
  }

  const tracking = new TrackingHub(logger.child({ component: 'tracking' }));
  const app = createApp(config, logger, {
    tracking,
    catalog: new ProjectionCatalog(() => broker.isConnected()),
    onEventsCommitted: kick,
    isBrokerConnected: () => broker.isConnected(),
  });

  startServer({
    app,
    port: config.PORT,
    logger,
    beforeClose: [() => tracking.close()],
    onShutdown: [() => expiry.stop(), () => relay.stop(), () => broker.close(), disconnectMongo],
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start order-service');
  process.exit(1);
});
