import {
  EventTypes,
  parseEventData,
  PermanentEventError,
  processOnce,
  routingKeyFor,
  EVENT_VERSION,
  type EventData,
  type EventEnvelope,
  type Logger,
  type MessageBroker,
} from '@food/common';
import type { ClientSession } from 'mongoose';
import { PAYMENT_STATUS_TRANSITIONS, type OrderStatus, type PaymentStatus } from '../models/order-status.js';
import { OrderModel, type IOrder } from '../models/order.model.js';
import { ConcurrentUpdateError, recordTransition } from '../services/lifecycle.js';

export const PAYMENT_EVENTS_QUEUE = 'order-service.payment-events';
const CONSUMER = 'order-service.payment-events';

const HANDLED = [
  EventTypes.PaymentSucceeded,
  EventTypes.PaymentFailed,
  EventTypes.PaymentCancelled,
  EventTypes.RefundCompleted,
  EventTypes.RefundFailed,
] as const;

interface Decision {
  paymentStatus: PaymentStatus;
  status?: OrderStatus;
  note: string;
}

/** Thrown when a compare-and-set lost a race; the broker retries the event shortly. */

/**
 * Applies a payment event to the order it belongs to.
 * The Order Service owns order state; the Payment Service only reports outcomes.
 * Returns what happened, for logging and tests.
 */
export async function applyPaymentEvent(event: EventEnvelope): Promise<'applied' | 'duplicate' | 'ignored'> {
  // A lost compare-and-set (e.g. the expiration worker or a cancellation committed first) is retried
  // immediately with fresh state; only persistent contention falls back to the broker's delayed retry.
  for (let attempt = 1; ; attempt++) {
    try {
      let outcome: 'applied' | 'ignored' = 'ignored';
      const fresh = await processOnce(CONSUMER, event.eventId, async (session) => {
        outcome = await apply(event, session);
      });
      return fresh ? outcome : 'duplicate';
    } catch (err) {
      if (!(err instanceof ConcurrentUpdateError) || attempt >= 3) throw err;
    }
  }
}

async function apply(event: EventEnvelope, session: ClientSession): Promise<'applied' | 'ignored'> {
  const { orderId, customerId, paymentId, note: baseNote, data } = describe(event);
  const order = await OrderModel.findById(orderId).session(session);
  if (!order) throw new PermanentEventError(`Order ${orderId} not found for ${event.eventType}`);
  if (order.customerId !== customerId) throw new PermanentEventError(`Customer mismatch for order ${orderId}`);

  const decision = decide(event, order, data, baseNote);
  if (!decision || !PAYMENT_STATUS_TRANSITIONS[order.paymentStatus].includes(decision.paymentStatus)) {
    return 'ignored'; // stale, duplicate-by-meaning, or out-of-order: never regress state
  }

  const now = new Date();
  const paymentUpdate = { eventId: event.eventId, eventType: event.eventType, paymentStatus: decision.paymentStatus, at: now, note: decision.note };

  if (decision.status === 'confirmed') {
    // The authoritative customer-visible transition: history + order.confirmed + order.status_changed, atomically.
    const d = data as EventData<typeof EventTypes.PaymentSucceeded>;
    const o = order.toObject();
    const ok = await recordTransition(session, o, 'confirmed', {
      cause: { eventId: event.eventId, service: event.source },
      by: 'payment-service',
      role: 'system',
      note: decision.note,
      metadata: { paymentId: d.paymentId, amountPaid: String(d.amount) },
      filter: { paymentStatus: order.paymentStatus },
      set: { paymentStatus: decision.paymentStatus, paymentId, amountPaid: d.amount },
      push: { paymentHistory: paymentUpdate },
      domainEvent: {
        eventType: EventTypes.OrderConfirmed,
        data: {
          orderId: o._id.toString(),
          orderNumber: o.orderNumber,
          customerId: o.customerId,
          restaurantId: o.restaurantId,
          restaurantName: o.restaurantName,
          paymentId: d.paymentId,
          ...(d.invoiceId ?? o.billing?.invoiceId ? { invoiceId: d.invoiceId ?? o.billing!.invoiceId } : {}),
          amountPaid: d.amount,
          currency: 'INR',
          deliveryAddress: o.deliveryAddress,
          items: o.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity })),
          customerEmail: o.customerEmail,
          customerName: o.customerName,
          confirmedAt: now.toISOString(),
        },
      },
    });
    if (!ok) throw new ConcurrentUpdateError(`Order ${orderId} changed concurrently`);
    return 'applied';
  }

  // Payment-only changes (no status transition → no customer-facing status event).
  const res = await OrderModel.updateOne(
    { _id: order._id, status: order.status, paymentStatus: order.paymentStatus },
    { $set: { paymentStatus: decision.paymentStatus, paymentId }, $push: { paymentHistory: paymentUpdate } },
    { session },
  );
  if (res.modifiedCount !== 1) throw new ConcurrentUpdateError(`Order ${orderId} changed concurrently`);
  return 'applied';
}

function describe(event: EventEnvelope) {
  switch (event.eventType) {
    case EventTypes.PaymentSucceeded: {
      const d = parseEventData(event, EventTypes.PaymentSucceeded);
      return { ...d, note: `Payment ${d.paymentId} succeeded via ${d.provider} (${d.providerReference})`, data: d };
    }
    case EventTypes.PaymentFailed: {
      const d = parseEventData(event, EventTypes.PaymentFailed);
      return { ...d, note: `Payment failed: ${d.reason}${d.retryable ? ' (retry allowed)' : ''}`, data: d };
    }
    case EventTypes.PaymentCancelled: {
      const d = parseEventData(event, EventTypes.PaymentCancelled);
      return { ...d, note: `Payment cancelled: ${d.reason}`, data: d };
    }
    case EventTypes.RefundCompleted: {
      const d = parseEventData(event, EventTypes.RefundCompleted);
      return { ...d, note: `Refund ${d.refundId} of ${d.amount} paise completed (total refunded ${d.totalRefunded})`, data: d };
    }
    case EventTypes.RefundFailed: {
      const d = parseEventData(event, EventTypes.RefundFailed);
      return { ...d, note: `Refund ${d.refundId} failed: ${d.reason}`, data: d };
    }
    default:
      throw new PermanentEventError(`Unexpected event type ${event.eventType}`);
  }
}

function decide(event: EventEnvelope, order: IOrder, data: { amount: number; fullyRefunded?: boolean }, note: string): Decision | null {
  switch (event.eventType) {
    case EventTypes.PaymentSucceeded:
      // The Billing Service's invoice is authoritative. Once mirrored, the charge must equal it exactly;
      // before the mirror arrives, a charge can only be ≤ the provisional total (discounts only, no tax yet).
      if (order.billing ? data.amount !== order.billing.finalAmount : data.amount > order.provisionalTotal || data.amount <= 0) {
        throw new PermanentEventError(
          `Paid amount ${data.amount} does not match the invoice (${order.billing?.finalAmount ?? `≤ ${order.provisionalTotal}`})`,
        );
      }
      if (order.status === 'pending_payment') return { paymentStatus: 'paid', status: 'confirmed', note };
      // Paid after the order was cancelled or expired (race / delayed webhook): the Payment Service refunds
      // automatically. The order is never revived.
      if (order.status === 'cancelled' || order.status === 'expired') {
        return { paymentStatus: 'refund_pending', note: `${note}; order already ${order.status}, refund expected` };
      }
      return { paymentStatus: 'paid', note };
    case EventTypes.PaymentFailed:
      // Only meaningful while the order is still awaiting payment; the order stays retryable.
      return order.status === 'pending_payment' ? { paymentStatus: 'failed', note } : null;
    case EventTypes.PaymentCancelled:
      return { paymentStatus: 'cancelled', note };
    case EventTypes.RefundCompleted:
      return { paymentStatus: data.fullyRefunded ? 'refunded' : 'partially_refunded', note };
    case EventTypes.RefundFailed:
      return { paymentStatus: 'refund_failed', note };
    default:
      return null;
  }
}

/** Subscribes the Order Service to payment lifecycle events (durable queue, retries, DLQ). */
export async function subscribePaymentEvents(broker: MessageBroker, logger: Logger, onCommitted: () => void = () => undefined): Promise<void> {
  await broker.subscribe({
    queue: PAYMENT_EVENTS_QUEUE,
    routingKeys: HANDLED.map((t) => routingKeyFor(t, EVENT_VERSION)),
    maxRetries: 5,
    retryDelayMs: 5000,
    handler: async (event) => {
      const outcome = await applyPaymentEvent(event);
      if (outcome === 'applied') onCommitted();
      logger.info({ eventId: event.eventId, eventType: event.eventType, outcome }, 'Payment event processed');
    },
  });
}
