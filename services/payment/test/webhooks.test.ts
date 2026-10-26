import request from 'supertest';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { handleOrderEvent } from '../src/consumers/order-events.js';
import { PaymentModel } from '../src/models/payment.model.js';
import { createHarness, orderCreated, outboxTypes, WEBHOOK_SECRET } from './helpers.js';
import { useTestDatabase } from './setup.js';
import { OutboxModel, eventDataSchemas, EventTypes } from '@food/common';

useTestDatabase();
const h = createHarness();

async function initiated() {
  const c = h.customer();
  const o = h.newOrder(c.id);
  await handleOrderEvent(h.workflow, orderCreated(o));
  await h.bill(o);
  const res = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id }).expect(201);
  return { c, o, paymentId: res.body.data.payment.id as string, pi: res.body.data.paymentIntentId as string };
}

const simulate = (c: { header: Record<string, string> }, paymentId: string, body: object) =>
  request(h.app).post(`/payments/${paymentId}/simulate`).set(c.header).send(body);

const piObject = (pi: string, overrides: object = {}) => ({ id: pi, object: 'payment_intent', status: 'succeeded', amount: 70700, currency: 'inr', metadata: {}, last_payment_error: null, ...overrides });

describe('Stripe webhook: confirmation', () => {
  it('marks the payment succeeded only from a verified webhook and emits payment.succeeded', async () => {
    const { c, o, paymentId, pi } = await initiated();
    h.autoDeliver.on = false;
    await simulate(c, paymentId, { outcome: 'succeed' }).expect(202);
    await h.mock.settle();
    // The client-side "success" alone changes nothing:
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('requires_action');
    h.autoDeliver.on = true;

    const res = await h.deliver(h.sent.at(-1)!);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('applied');
    expect(await PaymentModel.findById(paymentId).lean()).toMatchObject({ status: 'succeeded', providerPaymentIntentId: pi });
    const evt = await OutboxModel.findOne({ eventType: 'payment.succeeded', aggregateId: o.id }).lean();
    expect(eventDataSchemas[EventTypes.PaymentSucceeded].parse(evt!.envelope.data)).toMatchObject({ orderId: o.id, amount: 70700, provider: 'mock', providerReference: pi });
  });

  it('records failures as retryable; retry reuses the same PaymentIntent and can succeed', async () => {
    const { c, o, paymentId, pi } = await initiated();
    await simulate(c, paymentId, { outcome: 'fail' }).expect(202);
    await h.drive();
    const failed = (await PaymentModel.findById(paymentId).lean())!;
    expect(failed).toMatchObject({ status: 'failed', lastFailure: { code: 'generic_decline' } });
    const failEvt = await OutboxModel.findOne({ eventType: 'payment.failed', aggregateId: o.id }).lean();
    expect(failEvt!.envelope.data).toMatchObject({ retryable: true, failureCode: 'generic_decline' });

    const retry = await request(h.app).post('/payments/initiate').set(c.header).send({ orderId: o.id });
    expect(retry.status).toBe(200);
    expect(retry.body.data.paymentIntentId).toBe(pi);
    expect(retry.body.data.payment.status).toBe('requires_action');
    await simulate(c, paymentId, { outcome: 'succeed' }).expect(202);
    await h.drive();
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('succeeded');
    expect(await outboxTypes(o.id)).toEqual(['payment.failed', 'payment.succeeded']);
  });

  it('rejects invalid, missing and forged signatures with 400', async () => {
    const { pi } = await initiated();
    const payload = JSON.stringify({ id: 'evt_forged', object: 'event', type: 'payment_intent.succeeded', created: 1, livemode: false, data: { object: piObject(pi) } });
    const wrongSecret = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_attacker' });
    const good = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const post = (body: string, sig?: string) => {
      const r = request(h.app).post('/payments/webhook').set('content-type', 'application/json');
      return (sig ? r.set('stripe-signature', sig) : r).send(body);
    };
    expect((await post(payload)).status).toBe(400);
    expect((await post(payload, wrongSecret)).body.error.code).toBe('INVALID_SIGNATURE');
    expect((await post(payload.replace('70700', '1'), good)).status).toBe(400); // body tampered after signing
    const stale = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await post(payload, stale)).status).toBe(400); // replay outside tolerance
    expect((await PaymentModel.findOne({ providerPaymentIntentId: pi }).lean())!.status).toBe('requires_action');
  });

  it('processes duplicate webhook deliveries once', async () => {
    const { c, o, paymentId } = await initiated();
    await simulate(c, paymentId, { outcome: 'succeed', deliveries: 3 }).expect(202);
    await h.mock.settle();
    expect(h.sent.filter((w) => w.type === 'payment_intent.succeeded').length).toBeGreaterThanOrEqual(3);
    const again = await h.deliver(h.sent.at(-1)!);
    expect(again.body.data.result).toBe('duplicate');
    expect(await outboxTypes(o.id)).toEqual(['payment.succeeded']);
    expect((await PaymentModel.findById(paymentId).lean())!.statusHistory.filter((s) => s.status === 'succeeded')).toHaveLength(1);
  });

  it('ignores out-of-order webhooks that would regress a succeeded payment', async () => {
    const { c, o, paymentId, pi } = await initiated();
    await simulate(c, paymentId, { outcome: 'succeed' }).expect(202);
    await h.drive();
    const late = h.mock.signedWebhook('payment_intent.payment_failed', piObject(pi, { status: 'requires_payment_method', last_payment_error: { code: 'card_declined', message: 'late' } }));
    expect((await h.deliver(late)).body.data.result).toBe('stale');
    const processing = h.mock.signedWebhook('payment_intent.processing', piObject(pi, { status: 'processing' }));
    expect((await h.deliver(processing)).body.data.result).toBe('stale');
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('succeeded');
    expect(await outboxTypes(o.id)).toEqual(['payment.succeeded']);
  });

  it('acknowledges webhooks for unknown PaymentIntents without side effects', async () => {
    const w = h.mock.signedWebhook('payment_intent.succeeded', piObject('pi_unknown_123'));
    const res = await h.deliver(w);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('unknown');
    expect(await OutboxModel.countDocuments()).toBe(0);
  });

  it('ignores amount mismatches and unhandled event types', async () => {
    const { paymentId, pi } = await initiated();
    const tampered = h.mock.signedWebhook('payment_intent.succeeded', piObject(pi, { amount: 100 }));
    expect((await h.deliver(tampered)).body.data.result).toBe('anomaly');
    const other = h.mock.signedWebhook('customer.created', { id: 'cus_1', object: 'customer' });
    expect((await h.deliver(other)).status).toBe(200);
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('requires_action');
  });

  it('matches an early webhook by metadata before the PaymentIntent id is stored', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    await h.bill(o);
    const p = (await PaymentModel.findOne({ orderId: o.id }).lean())!;
    await PaymentModel.updateOne({ _id: p._id }, { $set: { status: 'requires_action' } });
    const early = h.mock.signedWebhook('payment_intent.succeeded', piObject('pi_mock_early', { metadata: { paymentId: p._id.toString() } }));
    expect((await h.deliver(early)).body.data.result).toBe('applied');
    expect(await PaymentModel.findById(p._id).lean()).toMatchObject({ status: 'succeeded', providerPaymentIntentId: 'pi_mock_early' });
  });

  it('polls the provider for payments stuck in processing (lost webhook)', async () => {
    const { c, paymentId, pi } = await initiated();
    await simulate(c, paymentId, { outcome: 'processing' }).expect(202);
    await h.drive();
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('processing');
    h.autoDeliver.on = false;
    await h.mock.settleProcessing(pi, 'succeed'); // provider finishes; webhook is "lost"
    await h.mock.settle();
    h.autoDeliver.on = true;
    await PaymentModel.updateOne({ _id: paymentId }, { $set: { 'reconcile.nextAttemptAt': new Date(0) } });
    await h.workflow.reconcile();
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('succeeded');
  });
});
