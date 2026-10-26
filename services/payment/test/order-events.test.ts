import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermanentEventError, createEnvelope } from '@food/common';
import { handleOrderEvent } from '../src/consumers/order-events.js';
import { PaymentModel } from '../src/models/payment.model.js';
import { createHarness, oid, orderCancelled, orderCreated, outboxTypes } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const h = createHarness();

afterEach(() => vi.restoreAllMocks());

describe('payment creation from order.created', () => {
  it('creates one pending payment whose amount stays unset until the invoice arrives', async () => {
    const o = h.newOrder(oid());
    expect(await handleOrderEvent(h.workflow, orderCreated(o))).toBe('processed');
    const p = await PaymentModel.findOne({ orderId: o.id }).lean();
    expect(p).toMatchObject({ orderId: o.id, customerId: o.customerId, currency: 'INR', status: 'pending', provider: 'mock', refundStatus: 'none' });
    expect(p!.amount).toBeUndefined(); // never the order's provisional total
    expect(p!.providerPaymentIntentId).toBeUndefined();
    await h.bill(o);
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())).toMatchObject({ amount: 70700, invoiceNumber: expect.stringMatching(/^INV-/) });
  });

  it('ignores redelivery of the same event', async () => {
    const o = h.newOrder(oid());
    const e = orderCreated(o);
    await handleOrderEvent(h.workflow, e);
    expect(await handleOrderEvent(h.workflow, e)).toBe('duplicate');
    expect(await PaymentModel.countDocuments({ orderId: o.id })).toBe(1);
  });

  it('never duplicates a payment even for a different event about the same order', async () => {
    const o = h.newOrder(oid());
    await handleOrderEvent(h.workflow, orderCreated(o));
    expect(await handleOrderEvent(h.workflow, orderCreated(o))).toBe('processed');
    expect(await PaymentModel.countDocuments({ orderId: o.id })).toBe(1);
  });

  it('rejects invalid payloads and missing order information permanently (→ DLQ)', async () => {
    const o = h.newOrder(oid());
    const missingTotal = orderCreated(o);
    delete (missingTotal.data as Record<string, unknown>).provisionalTotal;
    await expect(handleOrderEvent(h.workflow, missingTotal)).rejects.toBeInstanceOf(PermanentEventError);

    const fractional = orderCreated(o);
    (fractional.data as Record<string, unknown>).provisionalTotal = 707.5;
    await expect(handleOrderEvent(h.workflow, fractional)).rejects.toBeInstanceOf(PermanentEventError);

    const unknownType = createEnvelope({ eventType: 'order.exploded', version: 1, source: 'x', data: {} });
    await expect(handleOrderEvent(h.workflow, unknownType)).rejects.toBeInstanceOf(PermanentEventError);
    expect(await PaymentModel.countDocuments()).toBe(0);
  });

  it('surfaces database failures as retryable and succeeds on redelivery', async () => {
    const o = h.newOrder(oid());
    const e = orderCreated(o);
    vi.spyOn(PaymentModel, 'updateOne').mockRejectedValueOnce(new Error('connection reset by MongoDB'));
    const err = await handleOrderEvent(h.workflow, e).catch((x) => x);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentEventError);
    expect(await PaymentModel.countDocuments()).toBe(0);
    // Not marked processed, so the broker's retry applies it.
    expect(await handleOrderEvent(h.workflow, e)).toBe('processed');
    expect(await PaymentModel.countDocuments({ orderId: o.id })).toBe(1);
  });
});

describe('order.cancelled before any charge', () => {
  it('cancels a pending payment immediately and emits payment.cancelled', async () => {
    const o = h.newOrder(oid());
    await handleOrderEvent(h.workflow, orderCreated(o));
    await handleOrderEvent(h.workflow, orderCancelled(o));
    expect(await PaymentModel.findOne({ orderId: o.id }).lean()).toMatchObject({ status: 'cancelled', orderCancelReason: 'Changed my mind' });
    expect(await outboxTypes(o.id)).toEqual(['payment.cancelled']);
  });

  it('handles cancellation that arrives before order.created (out of order)', async () => {
    const o = h.newOrder(oid());
    await handleOrderEvent(h.workflow, orderCancelled(o));
    await handleOrderEvent(h.workflow, orderCreated(o)); // late — must not resurrect a payable record
    const all = await PaymentModel.find({ orderId: o.id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('cancelled');
  });

  it('treats repeated cancellation events (different ids) as one', async () => {
    const o = h.newOrder(oid());
    await handleOrderEvent(h.workflow, orderCreated(o));
    await handleOrderEvent(h.workflow, orderCancelled(o));
    expect(await handleOrderEvent(h.workflow, orderCancelled(o))).toBe('processed');
    expect(await outboxTypes(o.id)).toEqual(['payment.cancelled']);
  });
});
