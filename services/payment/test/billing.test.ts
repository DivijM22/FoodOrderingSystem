import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { OutboxModel, PermanentEventError } from '@food/common';
import { handleBillingEvent, handleOrderEvent } from '../src/consumers/order-events.js';
import { PaymentModel } from '../src/models/payment.model.js';
import { RefundModel } from '../src/models/refund.model.js';
import { createHarness, billingFinalized, oid, orderCancelled, orderCreated } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const h = createHarness();

const initiate = (c: { header: Record<string, string> }, orderId: string) => request(h.app).post('/payments/initiate').set(c.header).send({ orderId });

describe('Billing is the authoritative amount (Stage 5)', () => {
  it('charges the invoice finalAmount (discounted), not the order total', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id); // provisional 70700
    await handleOrderEvent(h.workflow, orderCreated(o));
    const inv = await h.bill(o, 5000); // WELCOME50-style discount
    const res = await initiate(c, o.id);
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({ amount: 65700, invoiceId: inv.invoiceId });
    expect((await h.mock.retrievePaymentIntent(res.body.data.paymentIntentId)).amount).toBe(65700);

    await request(h.app).post(`/payments/${res.body.data.payment.id}/simulate`).set(c.header).send({ outcome: 'succeed' }).expect(202);
    await h.drive();
    const evt = await OutboxModel.findOne({ eventType: 'payment.succeeded', aggregateId: o.id }).lean();
    expect(evt!.envelope.data).toMatchObject({ amount: 65700, invoiceId: inv.invoiceId });
  });

  it('waits for a delayed billing.finalized (BILLING_PENDING) and never charges an unfinalized amount', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    for (let i = 0; i < 3; i++) expect((await initiate(c, o.id)).body.error.code).toBe('BILLING_PENDING');
    expect(await h.mock.countIntents()).toBe(0);
    await h.bill(o, 10000); // the delayed event finally arrives
    const res = await initiate(c, o.id);
    expect(res.status).toBe(201);
    expect(res.body.data.payment.amount).toBe(60700);
  });

  it('accepts the deprecated billing.invoice_generated.v1 alias', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    await handleBillingEvent(h.workflow, billingFinalized(h.billing.invoiceFor(o), 'billing.invoice_generated'));
    expect((await initiate(c, o.id)).status).toBe(201);
  });

  it('carries the payment deadline on billing.finalized (no Order Service call needed)', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await h.bill(o); // billing.finalized arrives before order.created
    expect((await initiate(c, o.id)).body.error.code).toBe('ORDER_EXPIRED');
  });

  it('binds exactly one invoice per payment (duplicates ignored, a different invoice rejected)', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    const inv = await h.bill(o);
    const evt = billingFinalized(inv);
    await handleBillingEvent(h.workflow, evt);
    expect(await handleBillingEvent(h.workflow, evt)).toBe('duplicate');
    await expect(handleBillingEvent(h.workflow, billingFinalized({ ...inv, invoiceId: oid(), finalAmount: 1 }))).rejects.toBeInstanceOf(PermanentEventError);
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())!.amount).toBe(70700);
  });

  it('handles the invoice arriving before order.created', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await h.bill(o, 2000);
    await handleOrderEvent(h.workflow, orderCreated(o));
    const all = await PaymentModel.find({ orderId: o.id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ amount: 68700, status: 'pending' });
  });

  it('refunds exactly the charged invoice amount when a discounted order is cancelled', async () => {
    const c = h.customer();
    const o = h.newOrder(c.id);
    await handleOrderEvent(h.workflow, orderCreated(o));
    await h.bill(o, 5000);
    const res = await initiate(c, o.id);
    await request(h.app).post(`/payments/${res.body.data.payment.id}/simulate`).set(c.header).send({ outcome: 'succeed' }).expect(202);
    await h.drive();
    await handleOrderEvent(h.workflow, orderCancelled(o));
    await h.drive();
    expect(await PaymentModel.findOne({ orderId: o.id }).lean()).toMatchObject({ status: 'refunded', refundedAmount: 65700 });
    expect((await RefundModel.findOne({ orderId: o.id }).lean())!.amount).toBe(65700);
  });
});
