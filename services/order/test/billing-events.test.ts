import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger, OutboxModel, PermanentEventError } from '@food/common';
import { createApp } from '../src/app.js';
import { applyBillingEvent } from '../src/consumers/billing-events.js';
import { applyPaymentEvent } from '../src/consumers/payment-events.js';
import { OrderModel } from '../src/models/order.model.js';
import { address, config, FakeCatalog, ids, invoiceEvent, paymentEvent, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const app = createApp(config, createLogger('order-test', 'silent'), { catalog: new FakeCatalog() });
const customer = userToken('customer');

async function placeOrder(extra: object = {}) {
  const res = await request(app)
    .post('/orders')
    .set(customer.header)
    .send({ restaurantId: ids.restaurant, items: [{ menuItemId: ids.biryani, quantity: 2 }], deliveryAddress: address, ...extra });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; customerId: string; provisionalTotal: number; orderNumber: string; discountCode: string | null };
}

describe('discount codes on orders', () => {
  it('normalises and carries the code on order.created (validated later by Billing)', async () => {
    const o = await placeOrder({ discountCode: 'feast20' });
    expect(o.discountCode).toBe('FEAST20');
    const evt = await OutboxModel.findOne({ eventType: 'order.created', aggregateId: o.id }).lean();
    expect(evt!.envelope.data).toMatchObject({ discountCode: 'FEAST20' });
  });

  it('rejects malformed codes', async () => {
    const res = await request(app).post('/orders').set(customer.header).send({ restaurantId: ids.restaurant, items: [{ menuItemId: ids.raita, quantity: 1 }], deliveryAddress: address, discountCode: 'no spaces!' });
    expect(res.status).toBe(400);
  });
});

describe('billing.invoice_generated → order', () => {
  it('mirrors the final payable amount once (duplicates ignored)', async () => {
    const o = await placeOrder();
    const evt = invoiceEvent(o, { discountAmount: 5000, discountCode: 'WELCOME50' });
    expect(await applyBillingEvent(evt)).toBe('applied');
    expect(await applyBillingEvent(evt)).toBe('duplicate');
    expect(await applyBillingEvent(invoiceEvent(o, { discountAmount: 5000 }))).toBe('unchanged'); // same invoice, new event id
    const order = await request(app).get(`/orders/${o.id}`).set(customer.header);
    expect(order.body.data.billing).toMatchObject({ invoiceId: 'inv_test_1', discountAmount: 5000, taxAmount: 0, finalAmount: o.provisionalTotal - 5000 });
  });

  it('rejects a second, different invoice for the same order and unknown orders', async () => {
    const o = await placeOrder();
    await applyBillingEvent(invoiceEvent(o));
    await expect(applyBillingEvent(invoiceEvent(o, { invoiceId: 'inv_other' }))).rejects.toBeInstanceOf(PermanentEventError);
    await expect(applyBillingEvent(invoiceEvent({ ...o, id: '0123456789abcdef01234567' }))).rejects.toThrow(/not found/);
  });

  it('verifies payments against the invoice amount, not the provisional total', async () => {
    const o = await placeOrder();
    const discounted = o.provisionalTotal - 5000;
    await applyBillingEvent(invoiceEvent(o, { discountAmount: 5000 }));
    await expect(applyPaymentEvent(paymentEvent('payment.succeeded', o))).rejects.toThrow(/does not match the invoice/); // provisional ≠ invoice
    expect(await applyPaymentEvent(paymentEvent('payment.succeeded', o, { amount: discounted }))).toBe('applied');
    expect((await OrderModel.findById(o.id).lean())).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it('accepts a discounted payment that arrives before the invoice mirror (bounded check)', async () => {
    const o = await placeOrder();
    expect(await applyPaymentEvent(paymentEvent('payment.succeeded', o, { amount: o.provisionalTotal - 5000 }))).toBe('applied');
    await applyBillingEvent(invoiceEvent(o, { discountAmount: 5000 })); // late mirror still recorded
    expect((await OrderModel.findById(o.id).lean())!.billing!.finalAmount).toBe(o.provisionalTotal - 5000);
  });
});
