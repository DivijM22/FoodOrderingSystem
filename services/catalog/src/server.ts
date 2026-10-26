import { connectMongo, createLogger, disconnectMongo, MessageBroker, OutboxRelay, startServer } from '@food/common';
import { createApp } from './app.js';
import { loadCatalogConfig } from './config.js';
import { subscribeAuthEvents } from './consumers/auth-events.js';
import { subscribeSyncRequests } from './consumers/sync-requests.js';
import { seedCatalog } from './seed/seed.js';
import { CatalogService } from './services/catalog.service.js';

const config = loadCatalogConfig();
const logger = createLogger('catalog-service', config.LOG_LEVEL);

async function main() {
  await connectMongo(config.MONGO_URI, logger);
  if (config.SEED_ON_START) {
    const result = await seedCatalog();
    logger.info(result, 'Catalog seed applied');
  }

  // Catalog changes are published as events (outbox) so other services keep local read models.
  const broker = new MessageBroker({ url: config.RABBITMQ_URL, exchange: config.EVENT_EXCHANGE, logger });
  await broker.connect();
  const relay = new OutboxRelay(broker, logger.child({ component: 'outbox-relay' }), { pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS });
  relay.start();
  const service = new CatalogService(() => relay.kick());
  // ownerId → adminIds (idempotent; before the startup broadcast so the projection receives the new shape).
  const migrated = await service.migrateOwnerIds();
  if (migrated) logger.info({ restaurants: migrated }, 'Migrated restaurant ownerId to adminIds');

  const broadcast = (reason: string) =>
    service
      .broadcastSnapshots()
      .then((n) => logger.info({ restaurants: n, reason }, 'Catalog snapshots broadcast'))
      .catch((err) => logger.error({ err }, 'Snapshot broadcast failed'));
  void broadcast('startup');
  const snapshotTimer = setInterval(() => void broadcast('periodic'), config.CATALOG_SNAPSHOT_INTERVAL_MS);
  snapshotTimer.unref();
  void subscribeSyncRequests(broker, service, logger.child({ component: 'sync-requests' })).catch((err) => logger.error({ err }, 'Failed to subscribe to sync requests'));
  void subscribeAuthEvents(broker, service, logger.child({ component: 'auth-events' })).catch((err) => logger.error({ err }, 'Failed to subscribe to auth events'));

  startServer({
    app: createApp(config, logger, { service, isBrokerConnected: () => broker.isConnected() }),
    port: config.PORT,
    logger,
    onShutdown: [async () => clearInterval(snapshotTimer), () => relay.stop(), () => broker.close(), disconnectMongo],
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start catalog-service');
  process.exit(1);
});
