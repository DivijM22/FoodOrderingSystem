import type { Logger, MessageBroker } from '@food/common';
import { handleOrderEvent } from '../services/notifier.js';

export const NOTIFICATION_QUEUE = 'notification-service.order-events';

/** Bound to order.# (all Order Service events); only order.status_changed.v1 becomes an email. */
export async function subscribeOrderEvents(
  broker: MessageBroker,
  logger: Logger,
  opts: { maxAttempts: number; onQueued: () => void },
  queue = NOTIFICATION_QUEUE,
) {
  await broker.subscribe({
    queue,
    routingKeys: ['order.#'],
    maxRetries: 5,
    retryDelayMs: 5000,
    handler: async (event) => {
      const outcome = await handleOrderEvent(event, { maxAttempts: opts.maxAttempts });
      if (outcome === 'queued') opts.onQueued();
      logger.debug({ eventId: event.eventId, eventType: event.eventType, outcome }, 'Order event processed');
    },
  });
}
