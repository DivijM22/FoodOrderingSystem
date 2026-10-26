import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@food/common';
import { handleOrderEvent } from '../src/consumers/order-events.js';
import { PaymentModel } from '../src/models/payment.model.js';
import { RefundModel } from '../src/models/refund.model.js';
import { PaymentWorkflow } from '../src/services/workflow.js';
import { createHarness, orderCancelled, orderCreated, orderExpired, outboxTypes } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const h = createHarness();

async function setup({ initiate = true } = {}) {
  const c = h.customer();
  const o = h.newOrder(c.id, { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  await handleOrderEvent(h.workflow, orderCreated(o));
  await h.bill(o);
  let paymentId = (await PaymentModel.findOne({ orderId: o.id }).lean())!._id.toString();
  let pi: string | undefined;
  if (initiate) {
    const res = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id }).expect(201);
    paymentId = res.body.data.payment.id;
    pi = res.body.data.paymentIntentId;
  }
  return { c, o, paymentId, pi };
}

/** What the Order Service does at the deadline: status → expired, then order.expired.v1. */
async function expire(o: { id: string }) {
  h.orders.orders.get(o.id)!.status = 'expired';
  return handleOrderEvent(h.workflow, orderExpired(h.orders.orders.get(o.id)!));
}

const load = async (id: string) => (await PaymentModel.findById(id).lean())!;
const simulate = (c: { header: Record<string, string> }, id: string, outcome = 'succeed') =>
  request(h.app).post(`/payments/${id}/simulate`).set(c.header).send({ outcome });

describe('order.expired → payment reversal', () => {
  it('cancels a payment that was never initiated', async () => {
    const { o, paymentId } = await setup({ initiate: false });
    await expire(o);
    expect(await load(paymentId)).toMatchObject({ status: 'cancelled', orderClosure: 'expired' });
    expect(await outboxTypes(o.id)).toEqual(['payment.cancelled']);
  });

  it('cancels an open PaymentIntent at the provider and refuses further attempts', async () => {
    const { c, o, paymentId, pi } = await setup();
    await expire(o);
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'cancelled', orderClosure: 'expired' });
    expect((await h.mock.retrievePaymentIntent(pi!)).status).toBe('canceled');
    expect(await outboxTypes(o.id)).toEqual(['payment.cancelled']);

    const again = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_EXPIRED');
    expect((await simulate(c, paymentId)).status).toBe(409); // the PaymentIntent cannot be paid any more
  });

  it('refuses initiation once the deadline has passed, even before order.expired arrives', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await handleOrderEvent(h.workflow, orderCreated(o));
    await h.bill(o);
    const res = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_EXPIRED');
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())!.providerPaymentIntentId).toBeUndefined();
  });

  it('a payment that succeeded before the deadline is unaffected (no expiry is emitted for paid orders)', async () => {
    const { c, o, paymentId } = await setup();
    await simulate(c, paymentId).expect(202);
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'succeeded' });
    expect(await outboxTypes(o.id)).toEqual(['payment.succeeded']);
  });

  it('handles duplicate expiration events (same and different ids) and expiry + cancellation once', async () => {
    const { o, paymentId } = await setup();
    const evt = (h.orders.orders.get(o.id)!.status = 'expired', orderExpired(h.orders.orders.get(o.id)!));
    expect(await handleOrderEvent(h.workflow, evt)).toBe('processed');
    expect(await handleOrderEvent(h.workflow, evt)).toBe('duplicate');
    await handleOrderEvent(h.workflow, orderExpired(h.orders.orders.get(o.id)!));
    await handleOrderEvent(h.workflow, orderCancelled(o)); // a stray cancellation as well
    await h.drive();
    await h.drive();
    expect((await load(paymentId)).status).toBe('cancelled');
    expect(await outboxTypes(o.id)).toEqual(['payment.cancelled']);
  });

  it('survives a restart between recording the expiry and cancelling the PaymentIntent', async () => {
    const { o, paymentId, pi } = await setup();
    await expire(o); // recorded; the reconciler "crashes" before running
    const restarted = new PaymentWorkflow(h.mock, createLogger('restarted', 'silent'), () => undefined, { pollAfterMs: 0 });
    await restarted.reconcile();
    await h.mock.settle();
    expect(await load(paymentId)).toMatchObject({ status: 'cancelled' });
    expect((await h.mock.retrievePaymentIntent(pi!)).status).toBe('canceled');
  });
});

describe('payment success vs expiration races', () => {
  it('delayed success webhook after expiry → captured, then refunded automatically', async () => {
    const { c, o, paymentId } = await setup();
    await expire(o); // PaymentIntent still open: the reconciler has not cancelled it yet
    await simulate(c, paymentId).expect(202); // customer completes the card step just in time
    await h.mock.settle(); // success webhook lands first
    expect((await load(paymentId)).status).toBe('refund_pending');
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'refunded', refundedAmount: 70700 });
    const refunds = await RefundModel.find({ paymentId }).lean();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ requestedBy: 'system:order-expired', reason: expect.stringMatching(/^Order expired/) });
    expect(await outboxTypes(o.id)).toEqual(['payment.succeeded', 'payment.refund.completed']);
  });

  it('expiry finds the intent already succeeded (webhook still in flight) → refund; late webhook is stale', async () => {
    const { c, o, paymentId, pi } = await setup();
    h.autoDeliver.on = false;
    await simulate(c, paymentId).expect(202);
    await h.mock.settle();
    h.autoDeliver.on = true;
    await expire(o);
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'refunded' });
    const late = h.sent.find((w) => w.type === 'payment_intent.succeeded' && w.payload.includes(pi!))!;
    expect((await h.deliver(late)).body.data.result).toBe('stale');
    expect(await RefundModel.countDocuments({ paymentId })).toBe(1);
  });

  it('concurrent card completion and expiry always end consistently (charge refunded or never taken)', async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => setup()));
    await Promise.all(runs.flatMap(({ c, o, paymentId }) => [simulate(c, paymentId), expire(o).then(() => h.workflow.reconcile())]));
    await h.drive();
    await h.drive();
    for (const { o, paymentId, pi } of runs) {
      const p = await load(paymentId);
      const intent = await h.mock.retrievePaymentIntent(pi!);
      const refunds = await RefundModel.countDocuments({ paymentId });
      if (intent.status === 'canceled') {
        expect(p.status).toBe('cancelled'); // never charged
        expect(refunds).toBe(0);
        expect(await outboxTypes(o.id)).toEqual(['payment.cancelled']);
      } else {
        expect(intent.status).toBe('succeeded'); // charged → must be refunded exactly once
        expect(p).toMatchObject({ status: 'refunded', refundedAmount: 70700 });
        expect(refunds).toBe(1);
      }
    }
  });
});
