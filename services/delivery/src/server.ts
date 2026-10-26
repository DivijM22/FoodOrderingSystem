import { connectMongo, createLogger, disconnectMongo, MessageBroker, OutboxRelay, RESTRICTED_EXCHANGE, sealedBox, startServer } from '@food/common';
import { createApp } from './app.js';
import { loadDeliveryConfig } from './config.js';
import { subscribeAuthEvents } from './consumers/auth-events.js';
import { subscribeOrderEvents } from './consumers/order-events.js';
import { DeliveryService } from './services/delivery.service.js';
import { DeliveryScheduler } from './workers/scheduler.js';

const config = loadDeliveryConfig();
const logger = createLogger('delivery-service', config.LOG_LEVEL);

async function main() {
  await connectMongo(config.MONGO_URI, logger);
  // May publish OTP commands to the pre-declared restricted exchange (write-only; it cannot read it).
  const broker = new MessageBroker({ url: config.RABBITMQ_URL, exchange: config.EVENT_EXCHANGE, logger, publishExchanges: [RESTRICTED_EXCHANGE] });
  await broker.connect();
  const relay = new OutboxRelay(broker, logger.child({ component: 'outbox-relay' }), { pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS });
  relay.start();

  const delivery = new DeliveryService(
    {
      preparationDelayMs: config.PREPARATION_DELAY_MS,
      assignmentDelayMs: config.ASSIGNMENT_DELAY_MS,
      assignmentRetryMs: config.ASSIGNMENT_RETRY_MS,
      assignmentMaxAttempts: config.ASSIGNMENT_MAX_ATTEMPTS,
      assignmentTimeoutMs: config.ASSIGNMENT_TIMEOUT_MS,
      otpTtlMs: config.OTP_TTL_MS,
      otpMaxAttempts: config.OTP_MAX_ATTEMPTS,
      otpMaxIssues: config.OTP_MAX_ISSUES,
      otpResendCooldownMs: config.OTP_RESEND_COOLDOWN_MS,
    },
    config.OTP_HMAC_KEY,
    sealedBox.loadSealingPublicKey(config.NOTIFICATION_OTP_PUBLIC_KEY),
    logger.child({ component: 'delivery' }),
    () => relay.kick(),
  );
  const scheduler = new DeliveryScheduler(delivery, logger.child({ component: 'scheduler' }), config.WORKER_INTERVAL_MS);
  scheduler.start();
  void subscribeOrderEvents(broker, delivery, logger.child({ component: 'order-events' }), () => relay.kick()).catch((err) =>
    logger.error({ err }, 'Failed to subscribe to order events'),
  );
  void subscribeAuthEvents(broker, delivery, logger.child({ component: 'auth-events' })).catch((err) => logger.error({ err }, 'Failed to subscribe to auth events'));

  startServer({
    app: createApp(config, logger, { delivery, isBrokerConnected: () => broker.isConnected() }),
    port: config.PORT,
    logger,
    onShutdown: [() => scheduler.stop(), () => relay.stop(), () => broker.close(), disconnectMongo],
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start delivery-service');
  process.exit(1);
});
