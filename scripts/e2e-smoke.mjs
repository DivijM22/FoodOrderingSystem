#!/usr/bin/env node
/**
 * End-to-end smoke test against the running Docker Compose stack (through the gateway).
 *   docker compose up -d --build && node scripts/e2e-smoke.mjs
 *
 * Verifies: register → login → JWT → browse → menu → order → history → tracking → cancel,
 * that order events (incl. order.status_changed.v1) reach RabbitMQ, and the key failure paths.
 * Env: GATEWAY_URL (default http://localhost:8080), RABBITMQ_API (default http://localhost:15672),
 *      RABBITMQ_USER / RABBITMQ_PASSWORD, ADMIN_EMAIL / ADMIN_PASSWORD.
 */
import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const RABBIT = process.env.RABBITMQ_API ?? 'http://localhost:15672';
const RABBIT_AUTH = 'Basic ' + Buffer.from(`${process.env.RABBITMQ_USER ?? 'food'}:${process.env.RABBITMQ_PASSWORD ?? 'food-dev-password'}`).toString('base64');
const INSPECT_QUEUE = `e2e.inspect.${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
function check(name, condition, info) {
  if (condition) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 400) : '');
  }
}

async function api(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function rabbit(method, path, body) {
  const res = await fetch(`${RABBIT}/api${path}`, {
    method,
    headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function waitFor(fn, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;

async function main() {
  console.log(`Gateway: ${GATEWAY}`);

  // Inspection queue bound to all order events (stands in for future consumers).
  await rabbit('PUT', `/exchanges/%2F/food.events`, { type: 'topic', durable: true });
  await rabbit('PUT', `/queues/%2F/${INSPECT_QUEUE}`, { durable: false, auto_delete: false });
  await rabbit('POST', `/bindings/%2F/e/food.events/q/${INSPECT_QUEUE}`, { routing_key: 'order.#' });

  console.log('\n1. Health');
  for (const svc of ['auth', 'catalog', 'order', 'payment', 'billing']) {
    const h = await api('GET', `/health/${svc}`);
    check(`${svc}-service healthy`, h.status === 200 && h.body.status === 'ok', h.body);
  }
  check('notification-service is internal (not routed by the gateway)', (await api('GET', '/health/notification')).status === 404);

  console.log('\n2. Register + login');
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'Hungry123';
  const reg = await api('POST', '/auth/register', { body: { name: 'E2E Customer', email, password, phone: '9876543210' } });
  check('register → 201 customer', reg.status === 201 && reg.body.data.role === 'customer', reg.body);
  const dup = await api('POST', '/auth/register', { body: { name: 'E2E Customer', email, password } });
  check('duplicate register → 409', dup.status === 409, dup.body);
  const bad = await api('POST', '/auth/login', { body: { email, password: 'wrong-pass1' } });
  check('wrong password → 401', bad.status === 401, bad.body);
  const login = await api('POST', '/auth/login', { body: { email, password } });
  const token = login.body?.data?.accessToken;
  check('login → JWT', login.status === 200 && typeof token === 'string' && token.split('.').length === 3, login.body);
  const me = await api('GET', '/auth/me', { token });
  check('GET /auth/me', me.status === 200 && me.body.data.email === email, me.body);
  check('invalid token → 401', (await api('GET', '/auth/me', { token: 'garbage' })).status === 401);

  console.log('\n3. Browse catalog');
  const list = await api('GET', '/restaurants?city=Hyderabad&sort=rating');
  check('list restaurants (Hyderabad)', list.status === 200 && list.body.data.length >= 1, list.body);
  const all = await api('GET', '/restaurants?limit=50');
  check('≥15 seeded restaurants', all.body.meta.total >= 15, all.body.meta);
  const restaurant = all.body.data.find((r) => r.slug === 'spice-route-biryani-house');
  const closed = all.body.data.find((r) => !r.isOpen);
  const menu = await api('GET', `/restaurants/${restaurant.id}/menu`);
  check('menu with categories', menu.status === 200 && menu.body.data.items.length >= 8, menu.body);
  const available = menu.body.data.items.filter((i) => i.isAvailable);
  const unavailable = menu.body.data.items.find((i) => !i.isAvailable);
  console.log(`     ${restaurant.name}: ${menu.body.data.items.length} items, categories: ${menu.body.data.categories.join(', ')}`);

  console.log('\n4. Place order');
  const address = { line1: '12, Road No. 3', city: 'Hyderabad', pincode: '500034' };
  const lines = [
    { menuItemId: available[0].id, quantity: 2 },
    { menuItemId: available[1].id, quantity: 1 },
  ];
  const expectedSubtotal = available[0].price * 2 + available[1].price;
  const idemKey = `e2e-${randomUUID()}`;
  // The Order Service prices from its catalog read model; right after a restart it may still be syncing (503 CATALOG_SYNC_PENDING).
  const order = await waitFor(async () => {
    const res = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: lines, deliveryAddress: address }, headers: { 'idempotency-key': idemKey } });
    return res.status === 503 ? null : res;
  }, 30_000);
  check('order → 201 pending_payment', order.status === 201 && order.body.data.status === 'pending_payment', order.body);
  check(`server-side subtotal ${rupees(expectedSubtotal)}`, order.body.data?.subtotal === expectedSubtotal, order.body.data);
  console.log(`     ${order.body.data.orderNumber}: subtotal ${rupees(order.body.data.subtotal)} + delivery ${rupees(order.body.data.deliveryFee)} = ${rupees(order.body.data.provisionalTotal)}`);
  const replay = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: lines, deliveryAddress: address }, headers: { 'idempotency-key': idemKey } });
  check('same Idempotency-Key → same order', replay.status === 200 && replay.body.data.id === order.body.data.id, replay.body);

  console.log('\n5. Failure paths');
  const tampered = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ ...lines[0], price: 1 }], deliveryAddress: address } });
  check('client-supplied price rejected → 400', tampered.status === 400, tampered.body);
  if (unavailable) {
    const un = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ menuItemId: unavailable.id, quantity: 1 }], deliveryAddress: address } });
    check('unavailable item → 422', un.status === 422 && un.body.error.code === 'ORDER_ITEMS_INVALID', un.body);
  }
  if (closed) {
    const closedMenu = await api('GET', `/restaurants/${closed.id}/menu`);
    const cl = await api('POST', '/orders', { token, body: { restaurantId: closed.id, items: [{ menuItemId: closedMenu.body.data.items[0].id, quantity: 1 }], deliveryAddress: address } });
    check('closed restaurant → 422 RESTAURANT_CLOSED', cl.status === 422 && cl.body.error.code === 'RESTAURANT_CLOSED', cl.body);
  }
  check('unauthenticated order → 401', (await api('POST', '/orders', { body: { restaurantId: restaurant.id, items: lines, deliveryAddress: address } })).status === 401);

  console.log('\n6. History + tracking');
  const second = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ menuItemId: available[2].id, quantity: 1 }], deliveryAddress: address } });
  const history = await api('GET', '/orders', { token });
  check('order history has both orders', history.status === 200 && history.body.meta.total === 2, history.body.meta);
  const detail = await api('GET', `/orders/${order.body.data.id}`, { token });
  check('order detail with status history', detail.status === 200 && detail.body.data.statusHistory.length === 1, detail.body);
  const h0 = detail.body.data.statusHistory[0];
  check('history entry carries source event + service', h0?.status === 'pending_payment' && typeof h0.sourceEventId === 'string' && h0.sourceService === 'order-service', h0);
  const tracking = await api('GET', `/orders/${order.body.data.id}/tracking`, { token });
  check(
    'tracking endpoint: steps + history, current = pending_payment',
    tracking.status === 200 && tracking.body.data.status === 'pending_payment' && tracking.body.data.steps.find((st) => st.current)?.status === 'pending_payment' && tracking.body.data.steps.some((st) => st.status === 'delivered' && !st.reached),
    tracking.body,
  );
  check('tracking requires authentication → 401', (await api('GET', `/orders/${order.body.data.id}/tracking`)).status === 401);

  console.log('\n7. Cancel');
  const cancel = await api('POST', `/orders/${second.body.data.id}/cancel`, { token, body: { reason: 'Ordered by mistake' } });
  check('cancel pending order → cancelled', cancel.status === 200 && cancel.body.data.status === 'cancelled', cancel.body);
  const again = await api('POST', `/orders/${second.body.data.id}/cancel`, { token, body: { reason: 'again' } });
  check('cancel twice → 409', again.status === 409, again.body);

  console.log('\n8. Order status is owned by the Order Service (event-driven only)');
  const adminLogin = await api('POST', '/auth/login', { body: { email: process.env.ADMIN_EMAIL ?? 'admin@food.local', password: process.env.ADMIN_PASSWORD ?? 'Admin@12345' } });
  const adminToken = adminLogin.body?.data?.accessToken;
  check('platform admin login', adminLogin.status === 200, adminLogin.body);
  const manualConfirm = await api('PATCH', `/orders/${order.body.data.id}/status`, { token: adminToken, body: { status: 'confirmed' } });
  check('no API sets order status directly, not even for admins (PATCH → 404)', manualConfirm.status === 404, manualConfirm.body);
  const cust = await api('PATCH', `/orders/${order.body.data.id}/status`, { token, body: { status: 'delivered' } });
  check('customer PATCH → 404', cust.status === 404, cust.body);
  const adminView = await api('GET', `/orders/${order.body.data.id}/tracking`, { token: adminToken });
  check('platform admin can track any order', adminView.status === 200, adminView.body);
  const otherEmail = `e2e-other-${Date.now()}@example.com`;
  await api('POST', '/auth/register', { body: { name: 'Other Customer', email: otherEmail, password } });
  const other = (await api('POST', '/auth/login', { body: { email: otherEmail, password } })).body.data.accessToken;
  check("another customer cannot track this order → 404", (await api('GET', `/orders/${order.body.data.id}/tracking`, { token: other })).status === 404);

  console.log('\n9. Catalog change reaches the Order Service read model (event-carried state)');
  const item = available[3] ?? available[0];
  const off = await api('PATCH', `/restaurants/${restaurant.id}/menu/${item.id}/availability`, { token: adminToken, body: { isAvailable: false } });
  check('admin marks a menu item unavailable (Catalog Service)', off.status === 200 && off.body.data.isAvailable === false, off.body);
  const refused = await waitFor(async () => {
    const r = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], deliveryAddress: address } });
    // Accepted before the update reached the read model (propagation lag, typically milliseconds): cancel and retry.
    if (r.status === 201) await api('POST', `/orders/${r.body.data.id}/cancel`, { token, body: { reason: 'smoke: read model lag' } });
    return r.status === 422 ? r : null;
  }, 15_000);
  check('order for that item refused by the Order Service once catalog.restaurant.updated arrives (422)', refused?.body.error.code === 'ORDER_ITEMS_INVALID', refused?.body);
  await api('PATCH', `/restaurants/${restaurant.id}/menu/${item.id}/availability`, { token: adminToken, body: { isAvailable: true } });
  const back = await waitFor(async () => {
    const r = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], deliveryAddress: address } });
    return r.status === 201 ? r : null;
  }, 15_000);
  check('item available again → order accepted', !!back, back?.body);
  if (back) await api('POST', `/orders/${back.body.data.id}/cancel`, { token, body: { reason: 'smoke cleanup' } });

  console.log('\n10. Events in RabbitMQ');
  const messages = await waitFor(async () => {
    const q = await rabbit('GET', `/queues/%2F/${INSPECT_QUEUE}`);
    return q?.messages >= 10 ? q : null;
  });
  const got = await rabbit('POST', `/queues/%2F/${INSPECT_QUEUE}/get`, { count: 50, ackmode: 'ack_requeue_false', encoding: 'auto' });
  const events = (got ?? []).map((m) => ({ key: m.routing_key, body: JSON.parse(m.payload) }));
  const keys = events.map((e) => e.key);
  const nCreated = keys.filter((k) => k === 'order.created.v1').length;
  const nCancelled = keys.filter((k) => k === 'order.cancelled.v1').length;
  check(`order events published (${nCreated} created, ${nCancelled} cancelled)`, messages && nCreated >= 3 && nCancelled >= 2, keys);
  const changes = events.filter((e) => e.key === 'order.status_changed.v1');
  check(
    'order.status_changed.v1 after every accepted transition (one per placement and per cancellation)',
    changes.filter((e) => e.body.data.status === 'pending_payment').length === nCreated && changes.filter((e) => e.body.data.status === 'cancelled').length === nCancelled && changes.some((e) => e.body.data.status === 'cancelled' && e.body.data.previousStatus === 'pending_payment'),
    changes.map((e) => e.body.data.status),
  );
  const createdEvt = events.find((e) => e.key === 'order.created.v1' && e.body.data.orderId === order.body.data.id);
  check('OrderCreated envelope matches order', createdEvt?.body.version === 1 && createdEvt?.body.data.provisionalTotal === order.body.data.provisionalTotal, createdEvt?.body);
  const cancelledEvt = events.find((e) => e.key === 'order.cancelled.v1');
  check('OrderCancelled carries reason', cancelledEvt?.body.data.reason === 'Ordered by mistake', cancelledEvt?.body);
  for (const e of events) console.log(`     ${e.key}  eventId=${e.body.eventId}  order=${e.body.data.orderNumber}`);
}

try {
  await main();
} catch (err) {
  failed++;
  console.error('\nSmoke test crashed:', err);
} finally {
  await rabbit('DELETE', `/queues/%2F/${INSPECT_QUEUE}`).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
