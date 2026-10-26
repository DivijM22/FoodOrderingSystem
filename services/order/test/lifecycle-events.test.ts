import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, eventDataSchemas, EventTypes, OutboxModel, PermanentEventError } from '@food/common';
import { createApp } from '../src/app.js';
import { applyBillingEvent } from '../src/consumers/billing-events.js';
import { applyDeliveryEvent, StepNotYetApplicableError } from '../src/consumers/delivery-events.js';
import { applyPaymentEvent } from '../src/consumers/payment-events.js';
import { OrderModel } from '../src/models/order.model.js';
import { ExpirationWorker } from '../src/services/expiration.worker.js';
import { address, config, deliveryEvent, DELIVERY_STEPS, FakeCatalog, ids, invoiceEvent, OWNER_ID, paymentEvent, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const logger = createLogger('order-test', 'silent');
const catalog = new FakeCatalog();
const app = createApp(config, logger, { catalog });
const customer = userToken('customer');
const owner = userToken('restaurant_admin', OWNER_ID);

async function placeOrder() {
  const res = await request(app).post('/orders').set(customer.header).send({ restaurantId: ids.restaurant, items: [{ menuItemId: ids.biryani, quantity: 2 }], deliveryAddress: address });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; customerId: string; provisionalTotal: number; orderNumber: string };
}
async function paidOrder() {
  const o = await placeOrder();
  await applyBillingEvent(invoiceEvent(o, { discountAmount: 5000, eventType: undefined }));
  await applyPaymentEvent(paymentEvent('payment.succeeded', o, { amount: o.provisionalTotal - 5000 }));
  return o;
}
const statusEvents = async (orderId: string) =>
  (await OutboxModel.find({ aggregateId: orderId, eventType: 'order.status_changed' }).sort({ createdAt: 1 }).lean()).map((e) =>
    eventDataSchemas[EventTypes.OrderStatusChanged].parse(e.envelope.data),
  );

beforeEach(() => catalog.reset());

describe('order.status_changed.v1 (customer-facing)', () => {
  it('is published for placement, confirmation, cancellation and expiry with notification-ready data', async () => {
    const o = await paidOrder();
    const [placed, confirmed] = await statusEvents(o.id);
    expect(placed).toMatchObject({ status: 'pending_payment', previousStatus: null, sequence: 1 });
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      previousStatus: 'pending_payment',
      sequence: 2,
      customerEmail: customer.email,
      customerName: customer.name,
      cause: { service: 'payment-service' },
      summary: { restaurantName: 'Spice Route Biryani House', total: o.provisionalTotal - 5000, amountPaid: o.provisionalTotal - 5000, currency: 'INR', deliveryCity: 'Bengaluru' },
    });
    expect(confirmed!.summary.items).toEqual([{ name: 'Chicken Dum Biryani', quantity: 2, lineTotal: 65800 }]);
    const domain = await OutboxModel.findOne({ aggregateId: o.id, eventType: 'order.confirmed' }).lean();
    expect(eventDataSchemas[EventTypes.OrderConfirmed].parse(domain!.envelope.data)).toMatchObject({ amountPaid: o.provisionalTotal - 5000, invoiceId: 'inv_test_1' });

    const c = await placeOrder();
    await request(app).post(`/orders/${c.id}/cancel`).set(customer.header).send({ reason: 'Ordered twice' }).expect(200);
    expect((await statusEvents(c.id)).at(-1)).toMatchObject({ status: 'cancelled', previousStatus: 'pending_payment', reason: 'Ordered twice', sequence: 2 });

    const e = await placeOrder();
    await new ExpirationWorker(logger).sweep(new Date(Date.now() + 16 * 60_000));
    expect((await statusEvents(e.id)).at(-1)).toMatchObject({ status: 'expired', reason: 'Payment deadline passed', cause: { service: 'order-service' } });
  });

  it('is NOT published for rejected or payment-only changes (no customer email for them)', async () => {
    const o = await placeOrder();
    await request(app).post(`/orders/${o.id}/cancel`).set(customer.header).send({ reason: 'changed mind' }).expect(200);
    const before = (await statusEvents(o.id)).length;
    // A late payment for a cancelled order is accepted as a payment fact (refund expected) but is not a status transition.
    expect(await applyPaymentEvent(paymentEvent('payment.succeeded', o))).toBe('applied');
    await applyPaymentEvent(paymentEvent('payment.failed', o));
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    expect((await statusEvents(o.id)).length).toBe(before);
    expect((await OrderModel.findById(o.id).lean())!.status).toBe('cancelled');
  });

  it('never carries OTPs or payment secrets', async () => {
    const o = await paidOrder();
    for (const t of DELIVERY_STEPS) await applyDeliveryEvent(deliveryEvent(t, o.id));
    const raw = JSON.stringify(await OutboxModel.find({ aggregateId: o.id }).lean());
    expect(raw).not.toMatch(/otp(?!ExpiresAt)|client_secret|_secret_|password/i);
  });
});

describe('delivery events → authoritative lifecycle', () => {
  it('walks the full lifecycle with a chronological, attributed history', async () => {
    const o = await paidOrder();
    const sent = DELIVERY_STEPS.map((t) => deliveryEvent(t, o.id));
    for (const e of sent) expect(await applyDeliveryEvent(e)).toBe('applied');
    const order = (await OrderModel.findById(o.id).lean())!;
    expect(order.status).toBe('delivered');
    expect(order.statusHistory.map((h) => h.status)).toEqual([
      'pending_payment', 'confirmed', 'assigning_delivery_partner', 'partner_assigned', 'out_for_delivery', 'location_reached', 'delivered',
    ]);
    expect(order.statusHistory.at(-1)!.status).toBe(order.status);
    expect(order.statusHistory[3]).toMatchObject({ sourceEventId: sent[1]!.eventId, sourceService: 'delivery-service', metadata: { agentName: 'Ravi K.' } });
    const evts = await statusEvents(o.id);
    expect(evts.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(evts[3]).toMatchObject({ status: 'partner_assigned', previousStatus: 'assigning_delivery_partner', metadata: { agentName: 'Ravi K.' } });
    // Later delivery facts carry only agentId; the display name is carried forward for customer messages.
    expect(evts[4]).toMatchObject({ status: 'out_for_delivery', metadata: { agentId: 'agent_1', agentName: 'Ravi K.' } });
  });

  it('ignores duplicates (same id and same fact with a new id)', async () => {
    const o = await paidOrder();
    const e = deliveryEvent('delivery.ready_for_pickup', o.id);
    await applyDeliveryEvent(e);
    expect(await applyDeliveryEvent(e)).toBe('duplicate');
    expect(await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id))).toBe('ignored');
    expect((await statusEvents(o.id)).filter((x) => x.status === 'assigning_delivery_partner')).toHaveLength(1);
  });

  it('retries a step that arrives before its predecessor, then applies it in order', async () => {
    const o = await paidOrder();
    const early = deliveryEvent('delivery.picked_up', o.id);
    await expect(applyDeliveryEvent(early)).rejects.toBeInstanceOf(StepNotYetApplicableError);
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    await applyDeliveryEvent(deliveryEvent('delivery.partner_assigned', o.id));
    expect(await applyDeliveryEvent(early)).toBe('applied'); // the broker's retry
    expect((await OrderModel.findById(o.id).lean())!.status).toBe('out_for_delivery');
  });

  it('rejects malformed payloads permanently and never changes state for them', async () => {
    const o = await paidOrder();
    await expect(applyDeliveryEvent(deliveryEvent('delivery.partner_assigned', o.id, { agentName: 42 }))).rejects.toBeInstanceOf(PermanentEventError);
    await expect(applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', '0123456789abcdef01234567'))).rejects.toThrow(/not found/);
    expect((await OrderModel.findById(o.id).lean())!.status).toBe('confirmed');
  });

  it('cancellation rules follow the new lifecycle', async () => {
    const o = await paidOrder();
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    expect((await request(app).post(`/orders/${o.id}/cancel`).set(customer.header).send({ reason: 'too slow' })).status).toBe(409);
    const byRestaurant = await request(app).post(`/orders/${o.id}/cancel`).set(owner.header).send({ reason: 'Out of stock' });
    expect(byRestaurant.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refund_pending' });
  });

  it('accepts the legacy billing.invoice_generated.v1 and the new billing.finalized.v1', async () => {
    const a = await placeOrder();
    const b = await placeOrder();
    expect(await applyBillingEvent(invoiceEvent(a))).toBe('applied');
    expect(await applyBillingEvent(invoiceEvent(b, { eventType: 'billing.finalized', invoiceId: 'inv_b', invoiceVersion: 1 }))).toBe('applied');
    expect((await OrderModel.findById(b.id).lean())!.billing!.invoiceId).toBe('inv_b');
  });
});
