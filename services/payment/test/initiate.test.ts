import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { handleOrderEvent } from '../src/consumers/order-events.js';
import { PaymentModel } from '../src/models/payment.model.js';
import { createHarness, oid, orderCancelled, orderCreated, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const h = createHarness();

async function setup() {
  const c = h.customer();
  const o = h.newOrder(c.id);
  await handleOrderEvent(h.workflow, orderCreated(o));
  await h.bill(o);
  return { c, o };
}

const initiate = (c: { header: Record<string, string> }, orderId: string, extra: object = {}) =>
  request(h.app).post('/payments/initiate').set(c.header).send({ orderId, ...extra });

describe('POST /payments/initiate', () => {
  it('creates a PaymentIntent for the order total and returns the client secret', async () => {
    const { c, o } = await setup();
    const res = await initiate(c, o.id);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ provider: 'mock', testMode: true, paymentIntentId: expect.stringMatching(/^pi_mock_/) });
    expect(res.body.data.clientSecret).toMatch(/_secret_/);
    expect(res.body.data.payment).toMatchObject({ amount: 70700, currency: 'INR', status: 'requires_action', attempts: 1 });
    const stored = await PaymentModel.findOne({ orderId: o.id }).lean();
    expect(stored!.providerPaymentIntentId).toBe(res.body.data.paymentIntentId);
    expect(JSON.stringify(stored)).not.toContain('_secret_'); // client secret is never persisted
  });

  it('requires authentication and the customer role', async () => {
    const { o } = await setup();
    expect((await request(h.app).post('/payments/initiate').send({ orderId: o.id })).status).toBe(401);
    expect((await initiate(userToken('platform_admin'), o.id)).status).toBe(403);
  });

  it('returns 404 for another customer’s order (ownership from the local payment record)', async () => {
    const { o } = await setup();
    const intruder = h.customer();
    expect((await initiate(intruder, o.id)).status).toBe(404);
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())!.providerPaymentIntentId).toBeUndefined();
  });

  it('rejects invalid or unknown orders', async () => {
    const c = h.customer();
    expect((await initiate(c, 'not-an-id')).status).toBe(400);
    // Unknown here may simply mean "not billed yet": explicit pending state, never a guess.
    const unknown = await initiate(c, oid());
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe('BILLING_PENDING');
    expect(unknown.headers['retry-after']).toBe('2');
  });

  it('refuses client-supplied amounts', async () => {
    const { c, o } = await setup();
    const res = await initiate(c, o.id, { amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/Unrecognized key/i);
  });

  it('reuses the same PaymentIntent on duplicate initiation (no second charge)', async () => {
    const { c, o } = await setup();
    const first = await initiate(c, o.id);
    const [second, third] = await Promise.all([initiate(c, o.id), initiate(c, o.id)]);
    expect(second.status).toBe(200);
    expect(second.body.data.paymentIntentId).toBe(first.body.data.paymentIntentId);
    expect(third.body.data.paymentIntentId).toBe(first.body.data.paymentIntentId);
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())!.attempts).toBe(3);
  });

  it('a burst of simultaneous first initiations creates exactly one PaymentIntent', async () => {
    const { c, o } = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => initiate(c, o.id)));
    expect(results.map((r) => r.status).every((s) => s === 200 || s === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.data.paymentIntentId));
    expect(ids.size).toBe(1);
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())!.providerPaymentIntentId).toBe([...ids][0]);
  });

  it('maps provider outages to 503 and recovers on retry with the same idempotency key', async () => {
    const { c, o } = await setup();
    h.mock.failNext('createPaymentIntent', 3); // outlasts the in-request retries
    const failed = await initiate(c, o.id);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())).toMatchObject({ status: 'pending' });

    const retry = await initiate(c, o.id);
    expect(retry.status).toBe(201);
    expect(retry.body.data.payment.status).toBe('requires_action');
  });

  it('answers BILLING_PENDING until billing.finalized has been processed, then charges the finalized amount', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id, { provisionalTotal: 31900 });
    await handleOrderEvent(h.workflow, orderCreated(o));
    const pending = await initiate(c, o.id);
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('BILLING_PENDING');
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())!.providerPaymentIntentId).toBeUndefined();
    await h.bill(o);
    const res = await initiate(c, o.id);
    expect(res.status).toBe(201);
    expect(res.body.data.payment.amount).toBe(31900);
  });

  it('refuses cancelled orders using the cancellation event (no call to the Order Service)', async () => {
    const { c, o } = await setup();
    await handleOrderEvent(h.workflow, orderCancelled(o));
    expect((await initiate(c, o.id)).body.error.code).toBe('ORDER_NOT_PAYABLE');
  });

  it('refuses to initiate an already paid order', async () => {
    const { c, o } = await setup();
    const res = await initiate(c, o.id);
    await request(h.app).post(`/payments/${res.body.data.payment.id}/simulate`).set(c.header).send({ outcome: 'succeed' }).expect(202);
    await h.drive();
    const again = await initiate(c, o.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PAID');
  });
});

describe('payment queries', () => {
  it('lets customers see only their own payments; admins see all', async () => {
    const a = await setup();
    const b = await setup();
    const pa = (await PaymentModel.findOne({ orderId: a.o.id }).lean())!;
    expect((await request(h.app).get(`/payments/${pa._id}`).set(a.c.header)).status).toBe(200);
    expect((await request(h.app).get(`/payments/${pa._id}`).set(b.c.header)).status).toBe(404);
    expect((await request(h.app).get(`/payments/order/${a.o.id}`).set(a.c.header)).body.data.orderId).toBe(a.o.id);
    expect((await request(h.app).get(`/payments/order/${a.o.id}`).set(b.c.header)).status).toBe(404);
    expect((await request(h.app).get('/payments').set(a.c.header)).body.meta.total).toBe(1);
    expect((await request(h.app).get('/payments').set(userToken('platform_admin').header)).body.meta.total).toBe(2);
    expect((await request(h.app).get('/payments').set(userToken('restaurant_admin').header)).status).toBe(403);
  });
});
