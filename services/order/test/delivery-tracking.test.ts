import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvelope, createLogger, EventTypes, OutboxModel, PermanentEventError } from '@food/common';
import { createApp } from '../src/app.js';
import { applyBillingEvent } from '../src/consumers/billing-events.js';
import { applyDeliveryEvent } from '../src/consumers/delivery-events.js';
import { applyPaymentEvent } from '../src/consumers/payment-events.js';
import { OrderModel } from '../src/models/order.model.js';
import { TrackingHub } from '../src/tracking/tracking.js';
import { address, config, deliveryEvent, DELIVERY_STEPS, FakeCatalog, ids, invoiceEvent, paymentEvent, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const logger = createLogger('order-test', 'silent');
const tracking = new TrackingHub(logger, { heartbeatMs: 200 });
const app = createApp(config, logger, { catalog: new FakeCatalog(), tracking });
const customer = userToken('customer');

async function paidOrder() {
  const res = await request(app).post('/orders').set(customer.header).send({ restaurantId: ids.restaurant, items: [{ menuItemId: ids.biryani, quantity: 2 }], deliveryAddress: address });
  const o = res.body.data as { id: string; customerId: string; provisionalTotal: number; orderNumber: string };
  await applyBillingEvent(invoiceEvent(o, {}));
  await applyPaymentEvent(paymentEvent('payment.succeeded', o, { amount: o.provisionalTotal }));
  return o;
}

const mirrorEvent = (type: 'delivery.cancelled' | 'delivery.assignment_failed', orderId: string) =>
  createEnvelope({
    eventType: type,
    version: 1,
    source: 'delivery-service',
    data:
      type === 'delivery.cancelled'
        ? { deliveryId: 'del_test_1', orderId, previousStatus: 'partner_assigned', reason: 'Order cancelled', agentId: 'agent_1', cancelledAt: new Date().toISOString() }
        : { deliveryId: 'del_test_1', orderId, attempts: 60, reason: 'No delivery partner available after 60 attempts', failedAt: new Date().toISOString() },
  });

describe('delivery mirror on the order', () => {
  it('order.confirmed carries the customer contact needed for the delivery code email', async () => {
    const o = await paidOrder();
    const confirmed = await OutboxModel.findOne({ aggregateId: o.id, eventType: 'order.confirmed' }).lean();
    expect(confirmed!.envelope.data).toMatchObject({ customerEmail: customer.email, customerName: customer.name, amountPaid: o.provisionalTotal });
  });

  it('records delivery status and the partner public details; tracking exposes them without secrets', async () => {
    const o = await paidOrder();
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    await applyDeliveryEvent(deliveryEvent('delivery.partner_assigned', o.id, { agentPhoneMasked: '+91 98XXXXXX10' }));
    const t = (await request(app).get(`/orders/${o.id}/tracking`).set(customer.header).expect(200)).body.data;
    expect(t).toMatchObject({
      status: 'partner_assigned',
      deliveryStatus: 'partner_assigned',
      deliveryPartner: { name: 'Ravi K.', phoneMasked: '+91 98XXXXXX10' },
      completed: false,
      terminal: false,
    });
    expect(t.history.at(-1)).toMatchObject({ status: 'partner_assigned', sourceService: 'delivery-service', metadata: { agentName: 'Ravi K.', agentPhoneMasked: '+91 98XXXXXX10' } });
    expect(JSON.stringify(t)).not.toMatch(/customerEmail|@test\.local|otp"/i);
  });

  it('full lifecycle: delivered only via the verified completion; code expiry visible only while arrived', async () => {
    const o = await paidOrder();
    for (const type of DELIVERY_STEPS.slice(0, 4)) await applyDeliveryEvent(deliveryEvent(type, o.id));
    const arrivedView = (await request(app).get(`/orders/${o.id}/tracking`).set(customer.header)).body.data;
    expect(arrivedView).toMatchObject({ status: 'location_reached', deliveryStatus: 'arrived', deliveryCodeExpiresAt: expect.any(String) });
    await expect(applyDeliveryEvent(deliveryEvent('delivery.completed', o.id, { otpVerified: undefined }))).rejects.toBeInstanceOf(PermanentEventError);
    expect((await OrderModel.findById(o.id).lean())!.status).toBe('location_reached');
    await applyDeliveryEvent(deliveryEvent('delivery.completed', o.id));
    const done = (await request(app).get(`/orders/${o.id}/tracking`).set(customer.header)).body.data;
    expect(done).toMatchObject({ status: 'delivered', deliveryStatus: 'delivered', completed: true, terminal: true, deliveryCodeExpiresAt: null });
    expect(done.timestamps.deliveredAt).toEqual(done.history.at(-1).at);
    expect(done.history.map((h: { status: string }) => h.status)).toEqual(['pending_payment', 'confirmed', 'assigning_delivery_partner', 'partner_assigned', 'out_for_delivery', 'location_reached', 'delivered']);
  });

  it('delivery.cancelled / assignment_failed only update the mirror (no transition, no email, no refund)', async () => {
    const o = await paidOrder();
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    const before = await OutboxModel.countDocuments({ aggregateId: o.id });
    expect(await applyDeliveryEvent(mirrorEvent('delivery.assignment_failed', o.id))).toBe('applied');
    const order = (await OrderModel.findById(o.id).lean())!;
    expect(order.status).toBe('assigning_delivery_partner');
    expect(order.delivery).toMatchObject({ status: 'assignment_failed', failureReason: expect.stringContaining('No delivery partner') });
    expect(order.statusHistory).toHaveLength(3);
    expect(await OutboxModel.countDocuments({ aggregateId: o.id })).toBe(before);
    const evt = mirrorEvent('delivery.cancelled', o.id);
    await applyDeliveryEvent(evt);
    expect(await applyDeliveryEvent(evt)).toBe('duplicate');
    expect((await OrderModel.findById(o.id).lean())!.delivery!.status).toBe('cancelled');
  });

  it('rejects facts about a different delivery for the same order', async () => {
    const o = await paidOrder();
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    await expect(applyDeliveryEvent(deliveryEvent('delivery.partner_assigned', o.id, { deliveryId: 'del_forged' }))).rejects.toBeInstanceOf(PermanentEventError);
    expect((await OrderModel.findById(o.id).lean())!.status).toBe('assigning_delivery_partner');
  });

  it('a delivery agent sees only orders assigned to them', async () => {
    const o = await paidOrder();
    const assignedAgent = userToken('delivery_agent', 'agent_1');
    const otherAgent = userToken('delivery_agent', 'agent_2');
    await request(app).get(`/orders/${o.id}`).set(assignedAgent.header).expect(404);
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    await applyDeliveryEvent(deliveryEvent('delivery.partner_assigned', o.id));
    await request(app).get(`/orders/${o.id}`).set(assignedAgent.header).expect(200);
    await request(app).get(`/orders/${o.id}`).set(otherAgent.header).expect(404);
  });
});

describe('live tracking (SSE)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await tracking.close();
    await new Promise((r) => server.close(r));
  });

  /** Collects SSE `tracking` messages until `until` returns true. */
  async function readStream(path: string, headers: Record<string, string>, until: (msgs: { id: string; data: { status: string; paymentStatus?: string } }[]) => boolean, onOpen?: () => Promise<void>) {
    const res = await fetch(`${base}${path}`, { headers });
    if (res.status !== 200) return { status: res.status, msgs: [] };
    const reader = res.body!.getReader();
    const msgs: { id: string; data: { status: string; paymentStatus?: string } }[] = [];
    let buf = '';
    let opened = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!block.includes('event: tracking')) continue;
        const id = /^id: (.*)$/m.exec(block)![1]!;
        msgs.push({ id, data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) });
      }
      if (!opened && msgs.length) {
        opened = true;
        await onOpen?.();
      }
      if (until(msgs)) break;
    }
    await reader.cancel().catch(() => undefined);
    return { status: res.status, headers: res.headers, msgs };
  }

  it('streams a snapshot, then every committed change, until delivered', async () => {
    const o = await paidOrder();
    const out = await readStream(
      `/orders/${o.id}/tracking/stream`,
      customer.header,
      (m) => m.at(-1)?.data.status === 'delivered',
      async () => {
        for (const type of DELIVERY_STEPS) await applyDeliveryEvent(deliveryEvent(type, o.id));
      },
    );
    expect(out.headers!.get('content-type')).toContain('text/event-stream');
    const statuses = out.msgs.map((m) => m.data.status);
    expect(statuses[0]).toBe('confirmed');
    expect(statuses.at(-1)).toBe('delivered');
    expect(out.msgs.at(-1)!.id).toBe('7'); // id = history length (reconnect cursor)
    // Each status appears in order (intermediate ones may coalesce if committed back-to-back).
    expect([...new Set(statuses)]).toEqual(statuses.filter((s, i) => statuses.indexOf(s) === i));
    expect(tracking.subscriberCount()).toBe(0);
  });

  it('enforces authentication and ownership; a reconnect gets the current snapshot', async () => {
    const o = await paidOrder();
    expect((await fetch(`${base}/orders/${o.id}/tracking/stream`)).status).toBe(401);
    expect((await fetch(`${base}/orders/${o.id}/tracking/stream`, { headers: userToken('customer').header })).status).toBe(404);
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    const again = await readStream(`/orders/${o.id}/tracking/stream`, { ...customer.header, 'last-event-id': '2' }, (m) => m.length >= 1);
    expect(again.msgs[0]!.data.status).toBe('assigning_delivery_partner');
  });

  it('a settled order gets its final snapshot and the stream ends', async () => {
    const o = await paidOrder();
    for (const type of DELIVERY_STEPS) await applyDeliveryEvent(deliveryEvent(type, o.id));
    const out = await readStream(`/orders/${o.id}/tracking/stream`, customer.header, () => false);
    expect(out.msgs.map((m) => m.data.status)).toEqual(['delivered']);
  });

  it('a cancelled paid order keeps streaming until the refund lands, then ends', async () => {
    const o = await paidOrder();
    await request(app).post(`/orders/${o.id}/cancel`).set(customer.header).send({ reason: 'Changed my mind' }).expect(200);
    const out = await readStream(
      `/orders/${o.id}/tracking/stream`,
      customer.header,
      (m) => m.at(-1)?.data.paymentStatus === 'refunded',
      async () => {
        await applyPaymentEvent(paymentEvent('payment.refund.completed', o));
      },
    );
    const last = out.msgs.at(-1)!.data as unknown as { status: string; paymentStatus: string; settled: boolean };
    expect(out.msgs[0]!.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refund_pending', settled: false });
    expect(last).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded', settled: true });
  });
});

describe('cancellation after delivery started', () => {
  it('a cancelled order ignores later delivery events and cannot become delivered', async () => {
    const o = await paidOrder();
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', o.id));
    await request(app).post(`/orders/${o.id}/cancel`).set(userToken('platform_admin').header).send({ reason: 'Restaurant closed early' }).expect(200);
    for (const type of DELIVERY_STEPS.slice(1)) expect(await applyDeliveryEvent(deliveryEvent(type, o.id))).toBe('ignored');
    expect((await OrderModel.findById(o.id).lean())!.status).toBe('cancelled');
  });

  it('nobody can cancel after pickup', async () => {
    const o = await paidOrder();
    for (const type of DELIVERY_STEPS.slice(0, 3)) await applyDeliveryEvent(deliveryEvent(type, o.id));
    const r = await request(app).post(`/orders/${o.id}/cancel`).set(userToken('platform_admin').header).send({ reason: 'late' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    expect(EventTypes.DeliveryCancelled).toBe('delivery.cancelled');
  });
});
