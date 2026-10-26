import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, PermanentEventError } from '@food/common';
import { createApp } from '../src/app.js';
import { applyPaymentEvent } from '../src/consumers/payment-events.js';
import { OrderModel } from '../src/models/order.model.js';
import { address, config, FakeCatalog, ids, paymentEvent, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

const catalog = new FakeCatalog();
const app = createApp(config, createLogger('order-test', 'silent'), { catalog });
const customer = userToken('customer');

async function placeOrder() {
  const res = await request(app)
    .post('/orders')
    .set(customer.header)
    .send({ restaurantId: ids.restaurant, items: [{ menuItemId: ids.biryani, quantity: 1 }], deliveryAddress: address });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; customerId: string; provisionalTotal: number };
}

const load = async (id: string) => (await OrderModel.findById(id).lean())!;

beforeEach(() => catalog.reset());

describe('payment events → order state', () => {
  it('payment.succeeded confirms the order and records history', async () => {
    const order = await placeOrder();
    expect(await applyPaymentEvent(paymentEvent('payment.succeeded', order))).toBe('applied');
    const o = await load(order.id);
    expect(o).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', paymentId: 'pay_test_1' });
    expect(o.statusHistory.at(-1)).toMatchObject({ status: 'confirmed', by: 'payment-service', role: 'system' });
    expect(o.paymentHistory).toHaveLength(1);
  });

  it('ignores a redelivered event (same eventId) — no duplicate history', async () => {
    const order = await placeOrder();
    const event = paymentEvent('payment.succeeded', order);
    expect(await applyPaymentEvent(event)).toBe('applied');
    expect(await applyPaymentEvent(event)).toBe('duplicate');
    const o = await load(order.id);
    expect(o.paymentHistory).toHaveLength(1);
    expect(o.statusHistory.filter((h) => h.status === 'confirmed')).toHaveLength(1);
  });

  it('payment.failed keeps the order payable; a later success still confirms it', async () => {
    const order = await placeOrder();
    await applyPaymentEvent(paymentEvent('payment.failed', order));
    expect(await load(order.id)).toMatchObject({ status: 'pending_payment', paymentStatus: 'failed' });
    // The customer can still cancel (order not terminal) — and can retry payment:
    await applyPaymentEvent(paymentEvent('payment.succeeded', order));
    expect(await load(order.id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it('ignores out-of-order events that would regress state', async () => {
    const order = await placeOrder();
    await applyPaymentEvent(paymentEvent('payment.succeeded', order));
    expect(await applyPaymentEvent(paymentEvent('payment.failed', order))).toBe('ignored');
    expect(await applyPaymentEvent(paymentEvent('payment.cancelled', order))).toBe('ignored');
    expect(await load(order.id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it('success after cancellation (race) never revives the order; refund then converges', async () => {
    const order = await placeOrder();
    await request(app).post(`/orders/${order.id}/cancel`).set(customer.header).send({ reason: 'changed my mind' }).expect(200);
    expect(await applyPaymentEvent(paymentEvent('payment.succeeded', order))).toBe('applied');
    expect(await load(order.id)).toMatchObject({ status: 'cancelled', paymentStatus: 'refund_pending' });
    await applyPaymentEvent(paymentEvent('payment.refund.completed', order));
    expect(await load(order.id)).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
  });

  it('refunded is terminal; duplicate-by-meaning refund events are ignored', async () => {
    const order = await placeOrder();
    await applyPaymentEvent(paymentEvent('payment.succeeded', order));
    await request(app).post(`/orders/${order.id}/cancel`).set(customer.header).send({ reason: 'late' }).expect(200);
    expect((await load(order.id)).paymentStatus).toBe('refund_pending');
    await applyPaymentEvent(paymentEvent('payment.refund.completed', order));
    expect(await applyPaymentEvent(paymentEvent('payment.refund.completed', order))).toBe('ignored');
    expect(await applyPaymentEvent(paymentEvent('payment.refund.failed', order))).toBe('ignored');
    expect((await load(order.id)).paymentStatus).toBe('refunded');
  });

  it('records partial refunds and refund failures', async () => {
    const order = await placeOrder();
    await applyPaymentEvent(paymentEvent('payment.succeeded', order));
    await applyPaymentEvent(paymentEvent('payment.refund.completed', order, { amount: 1000, totalRefunded: 1000, fullyRefunded: false }));
    expect((await load(order.id)).paymentStatus).toBe('partially_refunded');
    await applyPaymentEvent(paymentEvent('payment.refund.failed', order));
    expect((await load(order.id)).paymentStatus).toBe('refund_failed');
  });

  it('payment.cancelled marks the payment of a cancelled unpaid order as cancelled', async () => {
    const order = await placeOrder();
    await request(app).post(`/orders/${order.id}/cancel`).set(customer.header).send({ reason: 'no longer hungry' }).expect(200);
    await applyPaymentEvent(paymentEvent('payment.cancelled', order));
    expect(await load(order.id)).toMatchObject({ status: 'cancelled', paymentStatus: 'cancelled' });
  });

  it('exposes paymentStatus and paymentHistory through the API', async () => {
    const order = await placeOrder();
    await applyPaymentEvent(paymentEvent('payment.failed', order));
    const res = await request(app).get(`/orders/${order.id}`).set(customer.header);
    expect(res.body.data).toMatchObject({ paymentStatus: 'failed', paymentId: 'pay_test_1' });
    expect(res.body.data.paymentHistory[0]).toMatchObject({ eventType: 'payment.failed', paymentStatus: 'failed' });
  });
});

describe('permanent errors (dead-lettered, not retried)', () => {
  it('rejects invalid payloads without marking the event processed', async () => {
    const order = await placeOrder();
    const bad = paymentEvent('payment.succeeded', order, { amount: 'lots' });
    await expect(applyPaymentEvent(bad)).rejects.toBeInstanceOf(PermanentEventError);
    expect((await load(order.id)).paymentStatus).toBe('pending');
  });

  it('rejects unknown orders, customer mismatches and amount mismatches', async () => {
    const order = await placeOrder();
    await expect(applyPaymentEvent(paymentEvent('payment.succeeded', { ...order, id: '0123456789abcdef01234567' }))).rejects.toThrow(/not found/);
    await expect(applyPaymentEvent(paymentEvent('payment.succeeded', { ...order, customerId: 'someone-else' }))).rejects.toThrow(/Customer mismatch/);
    await expect(applyPaymentEvent(paymentEvent('payment.succeeded', order, { amount: order.provisionalTotal + 1 }))).rejects.toThrow(/does not match/);
    expect(await load(order.id)).toMatchObject({ status: 'pending_payment', paymentStatus: 'pending' });
  });
});
