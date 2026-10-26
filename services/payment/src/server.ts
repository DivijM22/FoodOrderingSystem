import { connectMongo, createLogger, disconnectMongo, MessageBroker, OutboxRelay, startServer } from '@food/common';
import { createApp } from './app.js';
import { loadPaymentConfig } from './config.js';
import { subscribeBillingEvents, subscribeOrderEvents } from './consumers/order-events.js';
import { createProvider } from './providers/index.js';
import { Reconciler } from './services/reconciler.js';
import { PaymentWorkflow } from './services/workflow.js';

const config = loadPaymentConfig();
const logger = createLogger('payment-service', config.LOG_LEVEL);

async function main() {
  await connectMongo(config.MONGO_URI, logger);

  const broker = new MessageBroker({ url: config.RABBITMQ_URL, exchange: config.EVENT_EXCHANGE, logger });
  await broker.connect();
  const relay = new OutboxRelay(broker, logger.child({ component: 'outbox-relay' }), { pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS });

  const provider = createProvider(config, logger);
  let reconciler: Reconciler | undefined;
  const kick = () => {
    relay.kick();
    reconciler?.kick();
  };
  const workflow = new PaymentWorkflow(provider, logger.child({ component: 'workflow' }), kick, { pollAfterMs: config.PROVIDER_POLL_AFTER_MS });
  reconciler = new Reconciler(workflow, logger.child({ component: 'reconciler' }), config.RECONCILE_INTERVAL_MS);

  relay.start();
  reconciler.start();
  void subscribeOrderEvents(broker, workflow, logger.child({ component: 'order-events' })).catch((err) =>
    logger.error({ err }, 'Failed to subscribe to order events'),
  );
  void subscribeBillingEvents(broker, workflow, logger.child({ component: 'billing-events' })).catch((err) =>
    logger.error({ err }, 'Failed to subscribe to billing events'),
  );

  const app = createApp(config, logger, {
    workflow,
    kick,
    isBrokerConnected: () => broker.isConnected(),
  });

  startServer({
    app,
    port: config.PORT,
    logger,
    onShutdown: [() => reconciler!.stop(), () => relay.stop(), () => broker.close(), disconnectMongo],
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start payment-service');
  process.exit(1);
});
