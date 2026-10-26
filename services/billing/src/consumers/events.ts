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
import type { ClientSession } from 'mongoose';
import { SubtotalMismatchError } from '../services/calculator.js';
import type { BillingService } from '../services/billing.service.js';

export const BILLING_QUEUE = 'billing-service.events';
const CONSUMER = 'billing-service.events';

export const BILLING_SUBSCRIPTIONS = [
  EventTypes.OrderCreated,
  EventTypes.OrderCancelled,
  EventTypes.OrderExpired,
  EventTypes.PaymentSucceeded,
  EventTypes.RefundCompleted,
  EventTypes.RefundFailed,
] as const;

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

/**
 * Handles one event. The processed-event marker and all writes commit together; the message is acked
 * only afterwards. Ledger entries are unique per (kind, reference), so even distinct duplicate events
 * cannot double-count money.
 */
export async function handleBillingEvent(billing: BillingService, event: EventEnvelope): Promise<'processed' | 'duplicate'> {
  const id = event.eventId;
  let work: (s: ClientSession) => Promise<unknown>;
  switch (event.eventType) {
    case EventTypes.OrderCreated: {
      const d = parseEventData(event, EventTypes.OrderCreated);
      work = (s) =>
        billing.issueInvoice(
          s,
          {
            orderId: d.orderId,
            orderNumber: d.orderNumber,
            customerId: d.customerId,
            restaurantId: d.restaurantId,
            restaurantName: d.restaurantName,
            items: d.items,
            subtotal: d.subtotal,
            deliveryFee: d.deliveryFee,
            provisionalTotal: d.provisionalTotal,
            discountCode: d.discountCode,
            expiresAt: d.expiresAt,
          },
          `event:${id}`,
        );
      break;
    }
    case EventTypes.OrderCancelled: {
      const d = parseEventData(event, EventTypes.OrderCancelled);
      work = (s) => billing.onOrderClosed(s, d.orderId, `Order cancelled by ${d.cancelledBy}: ${d.reason}`, id);
      break;
    }
    case EventTypes.OrderExpired: {
      const d = parseEventData(event, EventTypes.OrderExpired);
      work = (s) => billing.onOrderClosed(s, d.orderId, 'Order expired: payment deadline passed', id);
      break;
    }
    case EventTypes.PaymentSucceeded: {
      const d = parseEventData(event, EventTypes.PaymentSucceeded);
      work = (s) => billing.onPaymentSucceeded(s, d, id);
      break;
    }
    case EventTypes.RefundCompleted: {
      const d = parseEventData(event, EventTypes.RefundCompleted);
      work = (s) => billing.onRefundCompleted(s, d, id);
      break;
    }
    case EventTypes.RefundFailed: {
      const d = parseEventData(event, EventTypes.RefundFailed);
      work = (s) => billing.onRefundFailed(s, d, id);
      break;
    }
    default:
      throw new PermanentEventError(`Unexpected event type ${event.eventType}`);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const fresh = await processOnce(CONSUMER, id, async (s) => {
        await work(s);
      });
      billing.notify();
      return fresh ? 'processed' : 'duplicate';
    } catch (err) {
      if (err instanceof SubtotalMismatchError) throw new PermanentEventError(err.message); // never invoice bad arithmetic
      // A concurrent duplicate created the invoice first: rerun — it now exists.
      if (isDuplicateKey(err) && attempt < 3) continue;
      throw err;
    }
  }
}

export async function subscribeBillingEvents(broker: MessageBroker, billing: BillingService, logger: Logger, queue = BILLING_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: BILLING_SUBSCRIPTIONS.map((t) => routingKeyFor(t, EVENT_VERSION)),
    maxRetries: 5,
    retryDelayMs: 5000,
    handler: async (event) => {
      const outcome = await handleBillingEvent(billing, event);
      logger.info({ eventId: event.eventId, eventType: event.eventType, outcome }, 'Billing event processed');
    },
  });
}
