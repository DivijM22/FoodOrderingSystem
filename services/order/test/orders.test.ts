import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, envelopeSchema, eventDataSchemas, EventTypes, OutboxModel, OutboxRelay } from '@food/common';
import { createApp } from '../src/app.js';
import { deliveryEvent, paymentEvent } from './helpers.js';
import { applyDeliveryEvent } from '../src/consumers/delivery-events.js';
import { applyPaymentEvent } from '../src/consumers/payment-events.js';
import { OrderModel } from '../src/models/order.model.js';
import { address, config, FakeCatalog, FakePublisher, ids, OWNER_ID, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

const logger = createLogger('order-test', 'silent');
const catalog = new FakeCatalog();
const publisher = new FakePublisher();
const relay = new OutboxRelay(publisher, logger, { pollIntervalMs: 10 });
let kicks = 0;
const app = createApp(config, logger, { catalog, onEventsCommitted: () => kicks++, isBrokerConnected: () => publisher.connected });

const customer = userToken('customer');
const otherCustomer = userToken('customer');
const platformAdmin = userToken('platform_admin');
const owner = userToken('restaurant_admin', OWNER_ID);
const otherOwner = userToken('restaurant_admin');
const agent = userToken('delivery_agent');

const basicOrder = {
  restaurantId: ids.restaurant,
  items: [
    { menuItemId: ids.biryani, quantity: 2 },
    { menuItemId: ids.raita, quantity: 1 },
  ],
  deliveryAddress: address,
};

async function placeOrder(body: object = basicOrder, who = customer) {
  return request(app).post('/orders').set(who.header).send(body);
}

async function transition(orderId: string, status: string, who = platformAdmin) {
  return request(app).patch(`/orders/${orderId}/status`).set(who.header).send({ status });
}

/** Confirms an order the only way now allowed: a verified payment.succeeded event. */
async function pay(order: { id: string; customerId: string; provisionalTotal: number }) {
  expect(await applyPaymentEvent(paymentEvent('payment.succeeded', order))).toBe('applied');
}

beforeEach(() => {
  catalog.reset();
  publisher.published = [];
  publisher.failNext = 0;
  publisher.connected = true;
  kicks = 0;
});

describe('POST /orders', () => {
  it('creates an order with server-side prices and item snapshots', async () => {
    const res = await placeOrder();
    expect(res.status).toBe(201);
    const order = res.body.data;
    expect(order).toMatchObject({
      customerId: customer.id,
      restaurantId: ids.restaurant,
      restaurantName: 'Spice Route Biryani House',
      subtotal: 2 * 32900 + 4900, // ₹707
      deliveryFee: 0, // ≥ ₹499 → free delivery
      provisionalTotal: 70700,
      currency: 'INR',
      status: 'pending_payment',
      paymentStatus: 'pending',
      deliveryAddress: address,
    });
    expect(order.orderNumber).toMatch(/^ORD-\d{6}-[A-Z2-9]{6}$/);
    expect(order.items).toEqual([
      { menuItemId: ids.biryani, name: 'Chicken Dum Biryani', unitPrice: 32900, isVeg: false, quantity: 2, lineTotal: 65800 },
      { menuItemId: ids.raita, name: 'Raita', unitPrice: 4900, isVeg: true, quantity: 1, lineTotal: 4900 },
    ]);
    expect(order.statusHistory).toHaveLength(1);
    expect(await OrderModel.countDocuments()).toBe(1);
  });

  it('charges the delivery fee below the free-delivery threshold', async () => {
    const res = await placeOrder({ ...basicOrder, items: [{ menuItemId: ids.paneer, quantity: 1 }] });
    expect(res.body.data).toMatchObject({ subtotal: 27900, deliveryFee: 4000, provisionalTotal: 31900 });
  });

  it('rejects client-supplied prices or totals outright', async () => {
    const res = await placeOrder({ ...basicOrder, items: [{ menuItemId: ids.biryani, quantity: 1, price: 1 }] });
    expect(res.status).toBe(400);
    const res2 = await placeOrder({ ...basicOrder, total: 100 });
    expect(res2.status).toBe(400);
  });

  it('merges duplicate lines and enforces quantity limits', async () => {
    const merged = await placeOrder({
      ...basicOrder,
      items: [
        { menuItemId: ids.raita, quantity: 2 },
        { menuItemId: ids.raita, quantity: 3 },
      ],
    });
    expect(merged.body.data.items).toEqual([expect.objectContaining({ menuItemId: ids.raita, quantity: 5, lineTotal: 24500 })]);

    expect((await placeOrder({ ...basicOrder, items: [{ menuItemId: ids.raita, quantity: 0 }] })).status).toBe(400);
    expect((await placeOrder({ ...basicOrder, items: [] })).status).toBe(400);
    const tooMany = await placeOrder({ ...basicOrder, items: [{ menuItemId: ids.raita, quantity: 15 }, { menuItemId: ids.raita, quantity: 15 }] });
    expect(tooMany.status).toBe(422);
  });

  it('writes an OrderCreated event to the outbox in the same transaction', async () => {
    const res = await placeOrder();
    expect(kicks).toBe(1);
    const events = await OutboxModel.find().lean();
    expect(events.map((e) => e.eventType).sort()).toEqual(['order.created', 'order.status_changed']);
    const env = events.find((e) => e.eventType === 'order.created')!.envelope;
    expect(envelopeSchema.safeParse(env).success).toBe(true);
    expect(env).toMatchObject({ eventType: 'order.created', version: 1, source: 'order-service' });
    const data = eventDataSchemas[EventTypes.OrderCreated].parse(env.data);
    expect(data).toMatchObject({ orderId: res.body.data.id, customerId: customer.id, provisionalTotal: 70700, currency: 'INR' });

    await relay.drain();
    expect(publisher.published.map((e) => e.eventType).sort()).toEqual(['order.created', 'order.status_changed']);
    expect((await OutboxModel.findById(env.eventId).lean())!.status).toBe('published');
    // The history entry cites the event it produced.
    const order = await request(app).get(`/orders/${res.body.data.id}`).set(customer.header);
    expect(order.body.data.statusHistory[0]).toMatchObject({ status: 'pending_payment', sourceEventId: env.eventId, sourceService: 'order-service' });
  });

  it('rejects unavailable items and items from another restaurant with field details', async () => {
    const res = await placeOrder({
      ...basicOrder,
      items: [
        { menuItemId: ids.biryani, quantity: 1 },
        { menuItemId: ids.unavailable, quantity: 1 },
        { menuItemId: ids.otherItem, quantity: 1 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORDER_ITEMS_INVALID');
    expect(res.body.error.details).toEqual([
      { path: 'items.1.menuItemId', message: 'Qubani Ka Meetha is currently unavailable' },
      { path: 'items.2.menuItemId', message: expect.stringContaining('not on this restaurant') },
    ]);
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await OutboxModel.countDocuments()).toBe(0);
  });

  it('rejects closed, inactive and unknown restaurants', async () => {
    const closed = await placeOrder({ ...basicOrder, restaurantId: ids.closedRestaurant });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('RESTAURANT_CLOSED');

    catalog.menus.get(ids.restaurant)!.restaurant.status = 'inactive';
    expect((await placeOrder()).body.error.code).toBe('RESTAURANT_NOT_FOUND');

    const unknown = await placeOrder({ ...basicOrder, restaurantId: '0123456789abcdef01234567' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('RESTAURANT_NOT_FOUND');
  });

  it('fails cleanly with 503 when the catalog is unreachable', async () => {
    catalog.down = true;
    const res = await placeOrder();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_UNAVAILABLE');
    expect(await OrderModel.countDocuments()).toBe(0);
  });

  it('only lets authenticated customers place orders', async () => {
    expect((await request(app).post('/orders').send(basicOrder)).status).toBe(401);
    expect((await placeOrder(basicOrder, owner)).status).toBe(403);
    expect((await placeOrder(basicOrder, agent)).status).toBe(403);
  });

  it('replays the original order for a repeated Idempotency-Key', async () => {
    const key = 'checkout-7f3c9a21';
    const first = await request(app).post('/orders').set(customer.header).set('idempotency-key', key).send(basicOrder);
    const second = await request(app).post('/orders').set(customer.header).set('idempotency-key', key).send(basicOrder);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await OrderModel.countDocuments()).toBe(1);
    expect(await OutboxModel.countDocuments({ eventType: 'order.created' })).toBe(1);

    // Same key from a different customer is independent.
    const other = await request(app).post('/orders').set(otherCustomer.header).set('idempotency-key', key).send(basicOrder);
    expect(other.status).toBe(201);
  });

  it('keeps snapshots when the menu price changes later', async () => {
    const res = await placeOrder();
    catalog.menus.get(ids.restaurant)!.items[0]!.price = 99900;
    const fetched = await request(app).get(`/orders/${res.body.data.id}`).set(customer.header);
    expect(fetched.body.data.items[0].unitPrice).toBe(32900);
    expect(fetched.body.data.provisionalTotal).toBe(70700);
  });
});

describe('order history and access control', () => {
  it('lists only the customer’s own orders, newest first, with pagination', async () => {
    const a = await placeOrder();
    const b = await placeOrder({ ...basicOrder, items: [{ menuItemId: ids.paneer, quantity: 1 }] });
    await placeOrder(basicOrder, otherCustomer);

    const res = await request(app).get('/orders?limit=1').set(customer.header);
    expect(res.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    expect(res.body.data[0].id).toBe(b.body.data.id);
    const page2 = await request(app).get('/orders?limit=1&page=2').set(customer.header);
    expect(page2.body.data[0].id).toBe(a.body.data.id);

    // A customer cannot widen the filter to someone else's orders.
    const sneaky = await request(app).get(`/orders?customerId=${otherCustomer.id}`).set(customer.header);
    expect(sneaky.body.meta.total).toBe(2);
  });

  it('filters history by status', async () => {
    const a = await placeOrder();
    await placeOrder();
    await request(app).post(`/orders/${a.body.data.id}/cancel`).set(customer.header).send({ reason: 'Ordered by mistake' });
    const res = await request(app).get('/orders?status=cancelled').set(customer.header);
    expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([a.body.data.id]);
  });

  it('hides other customers’ orders (404) and validates ids', async () => {
    const res = await placeOrder();
    expect((await request(app).get(`/orders/${res.body.data.id}`).set(otherCustomer.header)).status).toBe(404);
    expect((await request(app).get(`/orders/${res.body.data.id}`).set(customer.header)).status).toBe(200);
    expect((await request(app).get('/orders/xyz').set(customer.header)).status).toBe(400);
  });

  it('lets restaurant admins see only their restaurant’s orders', async () => {
    const res = await placeOrder();
    expect((await request(app).get('/orders').set(owner.header)).body.error.code).toBe('RESTAURANT_ID_REQUIRED');
    const list = await request(app).get(`/orders?restaurantId=${ids.restaurant}`).set(owner.header);
    expect(list.body.meta.total).toBe(1);
    expect((await request(app).get(`/orders?restaurantId=${ids.restaurant}`).set(otherOwner.header)).status).toBe(403);
    expect((await request(app).get(`/orders/${res.body.data.id}`).set(owner.header)).status).toBe(200);
    expect((await request(app).get(`/orders/${res.body.data.id}`).set(otherOwner.header)).status).toBe(404);
  });

  it('lets platform admins see everything', async () => {
    await placeOrder();
    await placeOrder(basicOrder, otherCustomer);
    const res = await request(app).get('/orders').set(platformAdmin.header);
    expect(res.body.meta.total).toBe(2);
    expect((await request(app).get(`/orders?customerId=${customer.id}`).set(platformAdmin.header)).body.meta.total).toBe(1);
  });
});

describe('cancellation', () => {
  it('lets a customer cancel a pending order and emits OrderCancelled', async () => {
    const { body } = await placeOrder();
    const res = await request(app).post(`/orders/${body.data.id}/cancel`).set(customer.header).send({ reason: 'Changed my mind' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'cancelled', cancellation: { reason: 'Changed my mind', role: 'customer' } });
    expect(res.body.data.statusHistory.map((h: { status: string }) => h.status)).toEqual(['pending_payment', 'cancelled']);

    await relay.drain();
    const domain = publisher.published.filter((e) => e.eventType !== 'order.status_changed');
    expect(domain.map((e) => e.eventType)).toEqual(['order.created', 'order.cancelled']);
    const data = eventDataSchemas[EventTypes.OrderCancelled].parse(domain[1]!.data);
    expect(data).toMatchObject({ orderId: body.data.id, cancelledBy: 'customer', previousStatus: 'pending_payment', paymentStatus: 'pending' });
  });

  it('marks paid orders as refund_pending when cancelled', async () => {
    const { body } = await placeOrder();
    await pay(body.data);
    expect((await request(app).get(`/orders/${body.data.id}`).set(customer.header)).body.data.paymentStatus).toBe('paid');
    const res = await request(app).post(`/orders/${body.data.id}/cancel`).set(customer.header).send({ reason: 'Taking too long' });
    expect(res.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refund_pending' });
    const event = (await OutboxModel.findOne({ eventType: 'order.cancelled' }).lean())!.envelope;
    expect(event.data).toMatchObject({ paymentStatus: 'paid', previousStatus: 'confirmed' });
  });

  it('rejects cancelling twice or after preparation has started (customer)', async () => {
    const a = await placeOrder();
    await request(app).post(`/orders/${a.body.data.id}/cancel`).set(customer.header).send({ reason: 'first time' }).expect(200);
    const again = await request(app).post(`/orders/${a.body.data.id}/cancel`).set(customer.header).send({ reason: 'second time' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_NOT_CANCELLABLE');

    const b = await placeOrder();
    await pay(b.body.data);
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', b.body.data.id));
    const late = await request(app).post(`/orders/${b.body.data.id}/cancel`).set(customer.header).send({ reason: 'too late' });
    expect(late.status).toBe(409);
    // …but the restaurant can still cancel while preparing (e.g. ran out of stock).
    const byRestaurant = await request(app).post(`/orders/${b.body.data.id}/cancel`).set(owner.header).send({ reason: 'Out of stock' });
    expect(byRestaurant.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refund_pending' });
  });

  it('does not let customers cancel other customers’ orders', async () => {
    const { body } = await placeOrder();
    const res = await request(app).post(`/orders/${body.data.id}/cancel`).set(otherCustomer.header).send({ reason: 'malicious' });
    expect(res.status).toBe(404);
    expect((await OrderModel.findById(body.data.id).lean())!.status).toBe('pending_payment');
  });
});

describe('status changes are event-driven only', () => {
  it('has no manual status endpoint any more (no role can set statuses by hand)', async () => {
    const { body } = await placeOrder();
    expect((await transition(body.data.id, 'confirmed')).status).toBe(404);
    expect((await transition(body.data.id, 'delivered', agent)).status).toBe(404);
  });

  it('exposes a tracking view whose last history element is the current status', async () => {
    const { body } = await placeOrder();
    await pay(body.data);
    await applyDeliveryEvent(deliveryEvent('delivery.ready_for_pickup', body.data.id));
    const t = await request(app).get(`/orders/${body.data.id}/tracking`).set(customer.header);
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ status: 'assigning_delivery_partner', terminal: false });
    expect(t.body.data.history.map((h: { status: string }) => h.status)).toEqual(['pending_payment', 'confirmed', 'assigning_delivery_partner']);
    expect(t.body.data.history.at(-1).status).toBe(t.body.data.status);
    expect(t.body.data.steps.filter((x: { reached: boolean }) => x.reached).map((x: { status: string }) => x.status)).toEqual(['pending_payment', 'confirmed', 'assigning_delivery_partner']);
    expect((await request(app).get(`/orders/${body.data.id}/tracking`).set(otherCustomer.header)).status).toBe(404);
  });
});

describe('GET /health', () => {
  it('stays healthy (degraded) when RabbitMQ is down', async () => {
    publisher.connected = false;
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { mongo: 'up', rabbitmq: 'down' } });
  });
});
