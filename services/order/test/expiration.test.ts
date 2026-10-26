import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, eventDataSchemas, EventTypes, OutboxModel } from '@food/common';
import { createApp } from '../src/app.js';
import { applyPaymentEvent } from '../src/consumers/payment-events.js';
import { OrderModel } from '../src/models/order.model.js';
import { ExpirationWorker } from '../src/services/expiration.worker.js';
import { address, config, FakeCatalog, ids, paymentEvent, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

const logger = createLogger('expiry-test', 'silent');
const catalog = new FakeCatalog();
const app = createApp({ ...config, ORDER_PAYMENT_DEADLINE_SECONDS: 900 }, logger, { catalog });
const customer = userToken('customer');
const MIN = 60_000;

async function placeOrder() {
  const res = await request(app)
    .post('/orders')
    .set(customer.header)
    .send({ restaurantId: ids.restaurant, items: [{ menuItemId: ids.biryani, quantity: 1 }], deliveryAddress: address });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; customerId: string; provisionalTotal: number; expiresAt: string; createdAt: string };
}

const load = async (id: string) => (await OrderModel.findById(id).lean())!;
const expiredEvents = (orderId?: string) => OutboxModel.countDocuments({ eventType: 'order.expired', ...(orderId ? { aggregateId: orderId } : {}) });
/** "Now" far enough in the future that every order created in the test is overdue. */
const later = () => new Date(Date.now() + 16 * MIN);

beforeEach(() => catalog.reset());

describe('payment deadline', () => {
  it('stores expiresAt = createdAt + 15 minutes and publishes it on order.created', async () => {
    const o = await placeOrder();
    expect(new Date(o.expiresAt).getTime() - new Date(o.createdAt).getTime()).toBe(15 * MIN);
    const created = await OutboxModel.findOne({ eventType: 'order.created', aggregateId: o.id }).lean();
    expect(created!.envelope.data).toMatchObject({ expiresAt: o.expiresAt });
  });

  it('honours a configured deadline', async () => {
    const quick = createApp({ ...config, ORDER_PAYMENT_DEADLINE_SECONDS: 60 }, logger, { catalog });
    const res = await request(quick).post('/orders').set(customer.header).send({ restaurantId: ids.restaurant, items: [{ menuItemId: ids.raita, quantity: 1 }], deliveryAddress: address });
    expect(new Date(res.body.data.expiresAt).getTime() - new Date(res.body.data.createdAt).getTime()).toBe(MIN);
  });
});

describe('ExpirationWorker', () => {
  it('expires an unpaid order after its deadline and emits order.expired.v1 (record kept)', async () => {
    const o = await placeOrder();
    const worker = new ExpirationWorker(logger);
    expect(await worker.sweep(new Date())).toBe(0); // not due yet
    expect(await worker.sweep(later())).toBe(1);

    const order = await load(o.id);
    expect(order).toMatchObject({ status: 'expired', paymentStatus: 'pending' });
    expect(order.expiredAt).toBeInstanceOf(Date);
    expect(order.statusHistory.at(-1)).toMatchObject({ status: 'expired', by: 'expiration-worker', role: 'system' });
    const evt = await OutboxModel.findOne({ eventType: 'order.expired', aggregateId: o.id }).lean();
    expect(eventDataSchemas[EventTypes.OrderExpired].parse(evt!.envelope.data)).toMatchObject({ orderId: o.id, paymentStatus: 'pending', provisionalTotal: o.provisionalTotal });
    expect(await OrderModel.countDocuments()).toBe(1); // never deleted
  });

  it('does not expire an order paid before the deadline', async () => {
    const o = await placeOrder();
    await applyPaymentEvent(paymentEvent('payment.succeeded', o));
    expect(await new ExpirationWorker(logger).sweep(later())).toBe(0);
    expect(await load(o.id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
    expect(await expiredEvents(o.id)).toBe(0);
  });

  it('still expires an order whose payment attempt failed', async () => {
    const o = await placeOrder();
    await applyPaymentEvent(paymentEvent('payment.failed', o));
    await new ExpirationWorker(logger).sweep(later());
    expect(await load(o.id)).toMatchObject({ status: 'expired', paymentStatus: 'failed' });
  });

  it('ignores cancelled orders', async () => {
    const o = await placeOrder();
    await request(app).post(`/orders/${o.id}/cancel`).set(customer.header).send({ reason: 'not hungry' }).expect(200);
    expect(await new ExpirationWorker(logger).sweep(later())).toBe(0);
    expect((await load(o.id)).status).toBe('cancelled');
  });

  it('survives restarts: a new worker finishes the backlog, nothing is expired twice', async () => {
    const orders = await Promise.all(Array.from({ length: 5 }, () => placeOrder()));
    const first = new ExpirationWorker(logger, undefined, { batchSize: 2 });
    expect(await first.sweep(later())).toBe(2);
    await first.stop(); // "crash"/restart
    const second = new ExpirationWorker(logger, undefined, { batchSize: 2 });
    let total = 2;
    for (let i = 0; i < 3; i++) total += await second.sweep(later());
    expect(total).toBe(5);
    for (const o of orders) expect(await expiredEvents(o.id)).toBe(1);
    expect(await new ExpirationWorker(logger).sweep(later())).toBe(0);
  });

  it('two workers (replicas) racing expire each order exactly once', async () => {
    const orders = await Promise.all(Array.from({ length: 6 }, () => placeOrder()));
    const now = later();
    const counts = await Promise.all([new ExpirationWorker(logger).sweep(now), new ExpirationWorker(logger).sweep(now)]);
    expect(counts[0]! + counts[1]!).toBe(6);
    for (const o of orders) expect(await expiredEvents(o.id)).toBe(1);
  });

  it('blocks payment-related actions on expired orders', async () => {
    const o = await placeOrder();
    await new ExpirationWorker(logger).sweep(later());
    const cancel = await request(app).post(`/orders/${o.id}/cancel`).set(customer.header).send({ reason: 'too late' });
    expect(cancel.status).toBe(409);
    // A late payment cannot revive it either (see the race tests below).
    const list = await request(app).get('/orders?status=expired').set(customer.header);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([o.id]);
  });
});

describe('payment vs expiration races', () => {
  it('delayed success webhook after expiry: order stays expired, refund expected, then refunded', async () => {
    const o = await placeOrder();
    await new ExpirationWorker(logger).sweep(later());
    expect(await applyPaymentEvent(paymentEvent('payment.succeeded', o))).toBe('applied');
    expect(await load(o.id)).toMatchObject({ status: 'expired', paymentStatus: 'refund_pending' });
    await applyPaymentEvent(paymentEvent('payment.refund.completed', o));
    expect(await load(o.id)).toMatchObject({ status: 'expired', paymentStatus: 'refunded' });
  });

  it('duplicate expiration cannot happen and payment.cancelled after expiry is recorded', async () => {
    const o = await placeOrder();
    const w = new ExpirationWorker(logger);
    await w.sweep(later());
    await w.sweep(later());
    expect(await expiredEvents(o.id)).toBe(1);
    await applyPaymentEvent(paymentEvent('payment.cancelled', o));
    expect(await load(o.id)).toMatchObject({ status: 'expired', paymentStatus: 'cancelled' });
  });

  it('concurrent payment success and expiry always converge to one consistent outcome', async () => {
    const orders = await Promise.all(Array.from({ length: 8 }, () => placeOrder()));
    const now = later();
    await Promise.all([
      new ExpirationWorker(logger).sweep(now),
      ...orders.map((o) => applyPaymentEvent(paymentEvent('payment.succeeded', o))),
    ]);
    for (const o of orders) {
      const order = await load(o.id);
      const expired = await expiredEvents(o.id);
      if (order.status === 'confirmed') {
        // payment won: never expired
        expect(order.paymentStatus).toBe('paid');
        expect(expired).toBe(0);
      } else {
        // expiry won: exactly one expiry event, and the captured payment is marked for refund
        expect(order.status).toBe('expired');
        expect(order.paymentStatus).toBe('refund_pending');
        expect(expired).toBe(1);
      }
    }
  });
});
