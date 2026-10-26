import {
  EVENT_VERSION,
  EventTypes,
  parseEventData,
  PermanentEventError,
  processOnce,
  routingKeyFor,
  type EventEnvelope,
  type Logger,
  type MessageBroker,
} from '@food/common';
import type { DeliveryService } from '../services/delivery.service.js';

export const DELIVERY_ORDER_QUEUE = 'delivery-service.order-events';
const CONSUMER = 'delivery-service.order-events';
const SUBSCRIPTIONS = [EventTypes.OrderConfirmed, EventTypes.OrderCancelled, EventTypes.OrderExpired] as const;

/**
 * order.confirmed creates the delivery; order.cancelled / order.expired close it (or leave a tombstone
 * so a delayed confirmation is ignored). Each event is applied at most once (processOnce) and its
 * writes + outbox events commit together; the broker acks only afterwards.
 */
export async function handleOrderEvent(delivery: DeliveryService, event: EventEnvelope): Promise<string> {
  let outcome = 'duplicate';
  switch (event.eventType) {
    case EventTypes.OrderConfirmed: {
      const d = parseEventData(event, EventTypes.OrderConfirmed);
      // Only a paid, confirmed order may start a delivery; it also needs an address for the OTP email.
      if (!d.paymentId || d.amountPaid <= 0) throw new PermanentEventError(`order.confirmed for ${d.orderId} carries no captured payment`);
      if (!d.customerEmail) throw new PermanentEventError(`order.confirmed for ${d.orderId} has no customer email (needed for the delivery code)`);
      await processOnce(CONSUMER, event.eventId, async (session) => {
        outcome = await delivery.createFromConfirmed(session, d, event.eventId);
      });
      break;
    }
    case EventTypes.OrderCancelled: {
      const d = parseEventData(event, EventTypes.OrderCancelled);
      await processOnce(CONSUMER, event.eventId, async (session) => {
        outcome = await delivery.closeForOrder(session, d.orderId, `Order cancelled: ${d.reason}`, event.eventId);
      });
      break;
    }
    case EventTypes.OrderExpired: {
      const d = parseEventData(event, EventTypes.OrderExpired);
      await processOnce(CONSUMER, event.eventId, async (session) => {
        outcome = await delivery.closeForOrder(session, d.orderId, 'Order expired before payment', event.eventId);
      });
      break;
    }
    default:
      throw new PermanentEventError(`Unexpected event type ${event.eventType}`);
  }
  return outcome;
}

export async function subscribeOrderEvents(broker: MessageBroker, delivery: DeliveryService, logger: Logger, onCommitted: () => void, queue = DELIVERY_ORDER_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: SUBSCRIPTIONS.map((t) => routingKeyFor(t, EVENT_VERSION)),
    maxRetries: 5,
    retryDelayMs: 3000,
    handler: async (event) => {
      const outcome = await handleOrderEvent(delivery, event);
      if (outcome === 'cancelled') onCommitted();
      logger.info({ eventId: event.eventId, eventType: event.eventType, outcome }, 'Order event processed');
    },
  });
}
