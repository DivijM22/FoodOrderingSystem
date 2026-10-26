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
import { closedFromCancelled, closedFromExpired, type PaymentWorkflow } from '../services/workflow.js';

export const ORDER_EVENTS_QUEUE = 'payment-service.order-events';
const CONSUMER = 'payment-service.order-events';

/**
 * Handles one order event. The processed-event marker and all resulting writes (payment record,
 * outbox events) commit in one transaction, so the broker message is acked only after durable
 * processing; a crash before commit means redelivery, and redelivery after commit is a no-op.
 */
export async function handleOrderEvent(workflow: PaymentWorkflow, event: EventEnvelope): Promise<'processed' | 'duplicate'> {
  const source = `event:${event.eventId}`;
  let fresh: boolean;
  // Contract violations throw PermanentEventError before any write (→ DLQ, no retries).
  if (event.eventType === EventTypes.OrderCreated) {
    const d = parseEventData(event, EventTypes.OrderCreated);
    fresh = await processOnce(CONSUMER, event.eventId, (s) => workflow.onOrderCreated(s, d));
  } else if (event.eventType === EventTypes.OrderCancelled) {
    const d = parseEventData(event, EventTypes.OrderCancelled);
    fresh = await processOnce(CONSUMER, event.eventId, (s) => workflow.onOrderClosed(s, closedFromCancelled(d), source));
  } else if (event.eventType === EventTypes.OrderExpired) {
    const d = parseEventData(event, EventTypes.OrderExpired);
    fresh = await processOnce(CONSUMER, event.eventId, (s) => workflow.onOrderClosed(s, closedFromExpired(d), source));
  } else {
    throw new PermanentEventError(`Unexpected event type ${event.eventType}`);
  }
  workflow.notify(); // publish outbox events / start provider work right away
  return fresh ? 'processed' : 'duplicate';
}

export async function subscribeOrderEvents(
  broker: MessageBroker,
  workflow: PaymentWorkflow,
  logger: Logger,
  queue = ORDER_EVENTS_QUEUE,
): Promise<void> {
  await broker.subscribe({
    queue,
    routingKeys: [EventTypes.OrderCreated, EventTypes.OrderCancelled, EventTypes.OrderExpired].map((t) => routingKeyFor(t, EVENT_VERSION)),
    maxRetries: 5,
    retryDelayMs: 5000,
    handler: async (event) => {
      const outcome = await handleOrderEvent(workflow, event);
      logger.info({ eventId: event.eventId, eventType: event.eventType, outcome }, 'Order event processed');
    },
  });
}

export const BILLING_EVENTS_QUEUE = 'payment-service.billing-events';

/** billing.finalized (or the deprecated billing.invoice_generated) → the amount this payment may charge (exactly once). */
export async function handleBillingEvent(workflow: PaymentWorkflow, event: EventEnvelope): Promise<'processed' | 'duplicate'> {
  const d =
    event.eventType === EventTypes.InvoiceGenerated
      ? parseEventData(event, EventTypes.InvoiceGenerated)
      : parseEventData(event, EventTypes.BillingFinalized);
  const fresh = await processOnce('payment-service.billing-events', event.eventId, async (s) => {
    await workflow.onInvoice(s, d, `event:${event.eventId}`);
  });
  workflow.notify();
  return fresh ? 'processed' : 'duplicate';
}

export async function subscribeBillingEvents(broker: MessageBroker, workflow: PaymentWorkflow, logger: Logger, queue = BILLING_EVENTS_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: [EventTypes.BillingFinalized, EventTypes.InvoiceGenerated].map((t) => routingKeyFor(t, EVENT_VERSION)),
    maxRetries: 5,
    retryDelayMs: 5000,
    handler: async (event) => {
      const outcome = await handleBillingEvent(workflow, event);
      logger.info({ eventId: event.eventId, outcome }, 'Billing event processed');
    },
  });
}
