import type { KeyObject } from 'node:crypto';
import { EVENT_VERSION, EventTypes, RESTRICTED_EXCHANGE, routingKeyFor, type Logger, type MessageBroker } from '@food/common';
import { handleOtpCommand } from '../services/notifier.js';

export const OTP_QUEUE = 'notification-service.delivery-otp';

/**
 * Restricted workflow: the only queue bound to the `food.restricted` exchange. Broker permissions let
 * only notification-service read this exchange/queue and only delivery-service publish to the exchange.
 */
export async function subscribeDeliveryOtp(
  broker: MessageBroker,
  logger: Logger,
  opts: { maxAttempts: number; privateKey: KeyObject; onQueued: () => void },
  queue = OTP_QUEUE,
  exchange = RESTRICTED_EXCHANGE,
) {
  await broker.subscribe({
    queue,
    exchange,
    routingKeys: [routingKeyFor(EventTypes.DeliveryOtpNotification, EVENT_VERSION)],
    maxRetries: 5,
    retryDelayMs: 2000,
    handler: async (event) => {
      const outcome = await handleOtpCommand(event, opts);
      if (outcome === 'queued') opts.onQueued();
      logger.info({ eventId: event.eventId, outcome }, 'Delivery code command processed'); // ids only, never the code
    },
  });
}
