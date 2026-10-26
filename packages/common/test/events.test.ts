import { describe, expect, it } from 'vitest';
import { createEnvelope, envelopeSchema, eventDataSchemas, EventTypes, parseEventData, PermanentEventError, routingKeyFor } from '../src/index.js';

describe('event contracts', () => {
  it('builds a valid envelope with a versioned routing key', () => {
    const env = createEnvelope({ eventType: EventTypes.OrderCreated, version: 1, source: 'order-service', data: {} });
    expect(envelopeSchema.safeParse(env).success).toBe(true);
    expect(routingKeyFor(env.eventType, env.version)).toBe('order.created.v1');
  });

  it('defines a schema for every event type', () => {
    for (const type of Object.values(EventTypes)) expect(eventDataSchemas[type]).toBeDefined();
  });

  it('rejects fractional money amounts', () => {
    const r = eventDataSchemas[EventTypes.RefundCompleted].safeParse({
      refundId: 'r', paymentId: 'p', orderId: 'o', customerId: 'c', amount: 10.5, refundedAt: new Date().toISOString(),
    });
    expect(r.success).toBe(false);
  });
});

describe('parseEventData', () => {
  const valid = {
    paymentId: 'p1', orderId: 'o1', customerId: 'c1', amount: 100, reason: 'card_declined', retryable: true, failedAt: new Date().toISOString(),
  };

  it('returns typed data for a valid event', () => {
    const data = parseEventData({ eventType: 'payment.failed', version: 1, data: valid }, EventTypes.PaymentFailed);
    expect(data.retryable).toBe(true);
  });

  it('throws PermanentEventError for contract violations, wrong type or unknown version', () => {
    expect(() => parseEventData({ eventType: 'payment.failed', version: 1, data: { orderId: 'o1' } }, EventTypes.PaymentFailed)).toThrow(PermanentEventError);
    expect(() => parseEventData({ eventType: 'payment.succeeded', version: 1, data: valid }, EventTypes.PaymentFailed)).toThrow(PermanentEventError);
    expect(() => parseEventData({ eventType: 'payment.failed', version: 2, data: valid }, EventTypes.PaymentFailed)).toThrow(/v2/);
  });

  it('uses dotted routing keys for refund events', () => {
    expect(routingKeyFor(EventTypes.RefundCompleted, 1)).toBe('payment.refund.completed.v1');
    expect(routingKeyFor(EventTypes.RefundFailed, 1)).toBe('payment.refund.failed.v1');
  });
});
