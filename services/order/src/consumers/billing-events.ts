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
import { OrderModel } from '../models/order.model.js';

export const BILLING_EVENTS_QUEUE = 'order-service.billing-events';
const CONSUMER = 'order-service.billing-events';

/**
 * Mirrors the invoice's final payable amount onto the order (display + payment verification).
 * Set once: an order has exactly one invoice; a different invoice for the same order is an anomaly.
 */
export async function applyBillingEvent(event: EventEnvelope): Promise<'applied' | 'duplicate' | 'unchanged'> {
  // billing.finalized.v1 (current) or the deprecated Stage 5 alias billing.invoice_generated.v1.
  const d =
    event.eventType === EventTypes.InvoiceGenerated
      ? parseEventData(event, EventTypes.InvoiceGenerated)
      : parseEventData(event, EventTypes.BillingFinalized);
  let outcome: 'applied' | 'unchanged' = 'unchanged';
  const fresh = await processOnce(CONSUMER, event.eventId, async (session) => {
    const order = await OrderModel.findById(d.orderId).session(session);
    if (!order) throw new PermanentEventError(`Order ${d.orderId} not found for invoice ${d.invoiceNumber}`);
    if (order.customerId !== d.customerId) throw new PermanentEventError(`Customer mismatch for invoice ${d.invoiceNumber}`);
    if (order.billing) {
      if (order.billing.invoiceId !== d.invoiceId) throw new PermanentEventError(`Order ${d.orderId} already has invoice ${order.billing.invoiceId}`);
      return; // same invoice, different event id: nothing to do
    }
    await OrderModel.updateOne(
      { _id: order._id, billing: { $exists: false } },
      {
        $set: {
          billing: {
            invoiceId: d.invoiceId,
            invoiceNumber: d.invoiceNumber,
            discountCode: d.discountCode,
            discountAmount: d.discountAmount,
            taxAmount: d.taxAmount,
            finalAmount: d.finalAmount,
            issuedAt: new Date(d.issuedAt),
          },
        },
      },
      { session },
    );
    outcome = 'applied';
  });
  return fresh ? outcome : 'duplicate';
}

export async function subscribeBillingEvents(broker: MessageBroker, logger: Logger, queue = BILLING_EVENTS_QUEUE): Promise<void> {
  await broker.subscribe({
    queue,
    routingKeys: [EventTypes.BillingFinalized, EventTypes.InvoiceGenerated].map((t) => routingKeyFor(t, EVENT_VERSION)),
    maxRetries: 5,
    retryDelayMs: 5000,
    handler: async (event) => {
      const outcome = await applyBillingEvent(event);
      logger.info({ eventId: event.eventId, outcome }, 'Billing event processed');
    },
  });
}
