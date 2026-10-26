import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { OutboxModel } from '@food/common';
import { handleOrderEvent } from '../src/consumers/order-events.js';
import { PaymentModel } from '../src/models/payment.model.js';
import { RefundModel } from '../src/models/refund.model.js';
import { createHarness, orderCancelled, orderCreated, outboxTypes, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const h = createHarness();
const admin = userToken('platform_admin');

async function paidOrder(outcome: 'succeed' | 'succeed_refund_fails' = 'succeed') {
  const c = h.customer();
  const o = h.newOrder(c.id);
  await handleOrderEvent(h.workflow, orderCreated(o));
  await h.bill(o);
  const init = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id }).expect(201);
  const paymentId = init.body.data.payment.id as string;
  await request(h.app).post(`/payments/${paymentId}/simulate`).set(c.header).send({ outcome }).expect(202);
  await h.drive();
  expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('succeeded');
  return { c, o, paymentId, pi: init.body.data.paymentIntentId as string };
}

const load = async (id: string) => (await PaymentModel.findById(id).lean())!;

describe('cancellation after successful payment → automatic refund', () => {
  it('refunds the full amount once Stripe confirms, emitting payment.refund.completed', async () => {
    const { o, paymentId } = await paidOrder();
    await handleOrderEvent(h.workflow, orderCancelled(o, { previousStatus: 'confirmed', paymentStatus: 'paid' }));
    expect(await load(paymentId)).toMatchObject({ status: 'refund_pending', refundStatus: 'pending' });
    // Refund not confirmed yet → no completion event yet.
    expect(await outboxTypes(o.id)).toEqual(['payment.succeeded']);

    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'refunded', refundStatus: 'succeeded', refundedAmount: 70700 });
    const refunds = await RefundModel.find({ paymentId }).lean();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'succeeded', amount: 70700, requestedBy: 'system:order-cancelled', providerRefundId: expect.stringMatching(/^re_mock_/) });
    const completed = await OutboxModel.findOne({ eventType: 'payment.refund.completed' }).lean();
    expect(completed!.envelope.data).toMatchObject({ amount: 70700, totalRefunded: 70700, fullyRefunded: true });
  });

  it('never refunds twice for repeated cancellation events or reconciler passes', async () => {
    const { o, paymentId } = await paidOrder();
    const cancel = orderCancelled(o);
    await handleOrderEvent(h.workflow, cancel);
    await handleOrderEvent(h.workflow, cancel); // redelivery
    await handleOrderEvent(h.workflow, orderCancelled(o)); // distinct duplicate cancellation
    await h.drive();
    await h.drive();
    expect(await RefundModel.countDocuments({ paymentId })).toBe(1);
    expect((await outboxTypes(o.id)).filter((t) => t === 'payment.refund.completed')).toHaveLength(1);
  });

  it('retries refund submission after transient provider errors with the same idempotency key', async () => {
    const { o, paymentId } = await paidOrder();
    h.mock.failNext('createRefund', 2);
    await handleOrderEvent(h.workflow, orderCancelled(o));
    await h.workflow.reconcile();
    const r = (await RefundModel.findOne({ paymentId }).lean())!;
    expect(r).toMatchObject({ status: 'pending', attempts: 1 });
    expect(r.lastError).toMatch(/injected transient failure/);
    // Backoff elapsed:
    await RefundModel.updateOne({ _id: r._id }, { $set: { nextAttemptAt: new Date(0) } });
    await h.workflow.reconcile();
    await RefundModel.updateOne({ _id: r._id }, { $set: { nextAttemptAt: new Date(0) } });
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'refunded' });
    expect(await RefundModel.countDocuments({ paymentId })).toBe(1);
  });

  it('records refund failures, restores the payment state and does not retry automatically', async () => {
    const { o, paymentId } = await paidOrder('succeed_refund_fails');
    await handleOrderEvent(h.workflow, orderCancelled(o));
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'succeeded', refundStatus: 'failed', refundedAmount: 0 });
    const r = (await RefundModel.findOne({ paymentId }).lean())!;
    expect(r).toMatchObject({ status: 'failed', failure: { message: 'expired_or_canceled_card' } });
    expect(await outboxTypes(o.id)).toEqual(['payment.succeeded', 'payment.refund.failed']);
    await h.drive();
    expect(await RefundModel.countDocuments({ paymentId })).toBe(1);
  });

  it('polls the provider when the refund webhook is lost', async () => {
    const { o, paymentId } = await paidOrder();
    h.autoDeliver.on = false;
    await handleOrderEvent(h.workflow, orderCancelled(o));
    await h.workflow.reconcile(); // submits
    await h.mock.settle(); // provider settles; webhook dropped
    h.autoDeliver.on = true;
    expect((await load(paymentId)).status).toBe('refund_pending');
    await h.workflow.reconcile(); // poll (pollAfterMs = 0 in tests)
    expect((await load(paymentId)).status).toBe('refunded');
  });
});

describe('cancellation before / during payment', () => {
  it('cancels an open PaymentIntent at the provider and emits payment.cancelled', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    await h.bill(o);
    const init = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id }).expect(201);
    await handleOrderEvent(h.workflow, orderCancelled(o));
    expect((await load(init.body.data.payment.id)).status).toBe('requires_action'); // cancel happens outside the txn
    await h.drive();
    expect(await load(init.body.data.payment.id)).toMatchObject({ status: 'cancelled' });
    expect((await h.mock.retrievePaymentIntent(init.body.data.paymentIntentId)).status).toBe('canceled');
    expect(await outboxTypes(o.id)).toEqual(['payment.cancelled']);
    // The customer can no longer pay:
    const pay = await request(h.app).post(`/payments/${init.body.data.payment.id}/simulate`).set(c.header).send({ outcome: 'succeed' });
    expect(pay.status).toBe(409);
  });

  it('race A: success webhook lands after the order was cancelled → refund, not a kept charge', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    await h.bill(o);
    const init = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id }).expect(201);
    const paymentId = init.body.data.payment.id;
    await handleOrderEvent(h.workflow, orderCancelled(o)); // recorded; PI cancel not yet attempted
    await request(h.app).post(`/payments/${paymentId}/simulate`).set(c.header).send({ outcome: 'succeed' }).expect(202);
    await h.mock.settle(); // success webhook applied first
    expect((await load(paymentId)).status).toBe('refund_pending');
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'refunded', refundedAmount: 70700 });
    expect(await outboxTypes(o.id)).toEqual(['payment.succeeded', 'payment.refund.completed']);
  });

  it('race B: cancel attempt finds the PaymentIntent already succeeded (webhook still in flight)', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    await h.bill(o);
    const init = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id }).expect(201);
    const paymentId = init.body.data.payment.id;
    h.autoDeliver.on = false;
    await request(h.app).post(`/payments/${paymentId}/simulate`).set(c.header).send({ outcome: 'succeed' }).expect(202);
    await h.mock.settle(); // provider says succeeded; our webhook is delayed
    h.autoDeliver.on = true;
    await handleOrderEvent(h.workflow, orderCancelled(o));
    await h.drive(); // cancel → IntentStateError → retrieve → succeeded → refund
    expect(await load(paymentId)).toMatchObject({ status: 'refunded' });
    // The delayed success webhook finally arrives: stale, changes nothing.
    const late = h.sent.find((w) => w.type === 'payment_intent.succeeded' && w.payload.includes(init.body.data.paymentIntentId))!;
    expect((await h.deliver(late)).body.data.result).toBe('stale');
    expect(await RefundModel.countDocuments({ paymentId })).toBe(1);
  });
});

describe('POST /payments/:id/refund (platform admin)', () => {
  const refund = (paymentId: string, body: object, key?: string, who = admin) => {
    const r = request(h.app).post(`/payments/${paymentId}/refund`).set(who.header);
    return (key ? r.set('idempotency-key', key) : r).send(body);
  };

  it('supports partial refunds and is idempotent per Idempotency-Key', async () => {
    const { paymentId, o } = await paidOrder();
    const first = await refund(paymentId, { amount: 20000, reason: 'Missing item' }, 'refund-key-0001');
    expect(first.status).toBe(202);
    const dup = await refund(paymentId, { amount: 20000, reason: 'Missing item' }, 'refund-key-0001');
    expect(dup.status).toBe(200);
    expect(dup.headers['idempotent-replayed']).toBe('true');
    expect(dup.body.data.id).toBe(first.body.data.id);
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'partially_refunded', refundedAmount: 20000 });
    expect(await RefundModel.countDocuments({ paymentId })).toBe(1);
    const evt = await OutboxModel.findOne({ eventType: 'payment.refund.completed', aggregateId: o.id }).lean();
    expect(evt!.envelope.data).toMatchObject({ amount: 20000, totalRefunded: 20000, fullyRefunded: false });

    // Remaining amount only:
    expect((await refund(paymentId, { amount: 60000, reason: 'too much' }, 'refund-key-0002')).body.error.code).toBe('REFUND_EXCEEDS_REMAINING');
    await refund(paymentId, { reason: 'Rest of it' }, 'refund-key-0003').expect(202);
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'refunded', refundedAmount: 70700 });
  });

  it('enforces authorization, Idempotency-Key and refundable states', async () => {
    const { c, paymentId } = await paidOrder();
    expect((await refund(paymentId, { reason: 'mine' }, 'refund-key-cust', c)).status).toBe(403);
    expect((await refund(paymentId, { reason: 'no key' })).status).toBe(400);
    await refund(paymentId, { amount: 10000, reason: 'first' }, 'refund-key-a1').expect(202);
    expect((await refund(paymentId, { amount: 10000, reason: 'second' }, 'refund-key-a2')).body.error.code).toBe('REFUND_IN_PROGRESS');

    const unpaid = h.customer();
    const order = h.newOrder(unpaid.id);
    await handleOrderEvent(h.workflow, orderCreated(order));
    const p = (await PaymentModel.findOne({ orderId: order.id }).lean())!;
    expect((await refund(p._id.toString(), { reason: 'not paid' }, 'refund-key-b1')).body.error.code).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  it('refunds only the remainder when an order is cancelled after a partial refund', async () => {
    const { o, paymentId } = await paidOrder();
    await refund(paymentId, { amount: 10000, reason: 'Late delivery' }, 'refund-key-p1').expect(202);
    await handleOrderEvent(h.workflow, orderCancelled(o)); // while the partial refund is in flight
    await h.drive();
    await h.drive();
    expect(await load(paymentId)).toMatchObject({ status: 'refunded', refundedAmount: 70700 });
    const amounts = (await RefundModel.find({ paymentId }).sort({ createdAt: 1 }).lean()).map((r) => r.amount);
    expect(amounts).toEqual([10000, 60700]);
  });
});
