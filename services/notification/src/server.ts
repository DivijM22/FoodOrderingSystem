import { connectMongo, createLogger, disconnectMongo, MessageBroker, sealedBox, startServer } from '@food/common';
import { createApp } from './app.js';
import { loadNotificationConfig } from './config.js';
import { subscribeDeliveryOtp } from './consumers/delivery-otp.js';
import { subscribeOrderEvents } from './consumers/order-events.js';
import { SmtpMailer } from './services/mailer.js';
import { Sender } from './services/notifier.js';

const config = loadNotificationConfig();
const logger = createLogger('notification-service', config.LOG_LEVEL);

async function main() {
  await connectMongo(config.MONGO_URI, logger);
  const broker = new MessageBroker({ url: config.RABBITMQ_URL, exchange: config.EVENT_EXCHANGE, logger });
  await broker.connect();

  const mailer = new SmtpMailer(
    { host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE, user: config.SMTP_USER, password: config.SMTP_PASSWORD, timeoutMs: config.SMTP_TIMEOUT_MS },
    config.MAIL_FROM,
  );
  // SMTP reachability for /health (optional dependency: queued notifications wait while it is down).
  let smtpUp = false;
  const probe = async () => {
    smtpUp = await mailer.verify();
  };
  void probe();
  const probeTimer = setInterval(() => void probe(), 15_000);
  probeTimer.unref();

  const otpPrivateKey = config.NOTIFICATION_OTP_PRIVATE_KEY ? sealedBox.loadSealingPrivateKey(config.NOTIFICATION_OTP_PRIVATE_KEY) : undefined;
  const sender = new Sender(mailer, logger.child({ component: 'sender' }), {
    intervalMs: config.SENDER_INTERVAL_MS,
    leaseMs: config.SEND_LEASE_MS,
    appName: config.APP_NAME,
    otpPrivateKey,
  });
  sender.start();
  void subscribeOrderEvents(broker, logger.child({ component: 'order-events' }), { maxAttempts: config.NOTIFY_MAX_ATTEMPTS, onQueued: () => sender.kick() }).catch(
    (err) => logger.error({ err }, 'Failed to subscribe to order events'),
  );

  if (otpPrivateKey) {
    void subscribeDeliveryOtp(broker, logger.child({ component: 'delivery-otp' }), { maxAttempts: config.NOTIFY_MAX_ATTEMPTS, privateKey: otpPrivateKey, onQueued: () => sender.kick() }).catch(
      (err) => logger.error({ err }, 'Failed to subscribe to delivery codes'),
    );
  } else {
    logger.error('NOTIFICATION_OTP_PRIVATE_KEY not set: delivery codes cannot be emailed');
  }

  startServer({
    app: createApp(logger, { isBrokerConnected: () => broker.isConnected(), isSmtpReachable: () => smtpUp, hasOtpKey: () => !!otpPrivateKey }),
    port: config.PORT,
    logger,
    onShutdown: [async () => clearInterval(probeTimer), () => sender.stop(), () => broker.close(), disconnectMongo],
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start notification-service');
  process.exit(1);
});
