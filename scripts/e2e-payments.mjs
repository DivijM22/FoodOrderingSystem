#!/usr/bin/env node
/**
 * Stage 4 end-to-end payment scenarios against the running Docker Compose stack (via the gateway).
 *
 *   node scripts/e2e-payments.mjs                # scenarios 1–4
 *   node scripts/e2e-payments.mjs --resilience   # + scenario 5 (stops/starts RabbitMQ, restarts payment-service)
 *   node scripts/e2e-payments.mjs --expiry       # + scenario 6 (temporarily recreates order-service with a 12 s
 *                                                #   payment deadline, then restores the default)
 *
 * The payment provider in the stack decides what is exercised: with PAYMENT_PROVIDER=mock (default)
 * payments are SIMULATED locally — this verifies our workflow, not Stripe. Customer actions
 * (entering a card) are played through POST /payments/:id/simulate; outcomes still arrive only
 * via signed webhooks.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const RABBIT = process.env.RABBITMQ_API ?? 'http://localhost:15672';
const RABBIT_AUTH = 'Basic ' + Buffer.from(`${process.env.RABBITMQ_USER ?? 'food'}:${process.env.RABBITMQ_PASSWORD ?? 'food-dev-password'}`).toString('base64');
const INSPECT = `e2e.payments.${randomUUID().slice(0, 8)}`;
const RESILIENCE = process.argv.includes('--resilience');
const EXPIRY = process.argv.includes('--expiry');
const SHORT_DEADLINE_S = 12;

let passed = 0;
let failed = 0;
function check(name, ok, info) {
  if (ok) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : '');
  }
}

async function api(method, path, { body, token, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${GATEWAY}${path}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    } catch (err) {
      if (attempt >= 10) throw err; // gateway briefly unavailable while containers restart
      await sleep(1000);
    }
  }
}

async function rabbit(method, path, body) {
  const res = await fetch(`${RABBIT}/api${path}`, { method, headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20_000, everyMs = 300) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------------ event capture
const events = [];
async function drain() {
  for (;;) {
    const got = await rabbit('POST', `/queues/%2F/${INSPECT}/get`, { count: 200, ackmode: 'ack_requeue_false', encoding: 'auto' }).catch(() => []);
    if (!Array.isArray(got) || got.length === 0) return;
    for (const m of got) events.push({ key: m.routing_key, body: JSON.parse(m.payload) });
  }
}
async function eventsFor(orderId) {
  await drain();
  return events.filter((e) => e.body.data?.orderId === orderId);
}
async function waitForEvent(orderId, key, timeoutMs = 20_000) {
  return waitFor(async () => (await eventsFor(orderId)).find((e) => e.key === key), timeoutMs);
}

// ------------------------------------------------------------------ helpers
const address = { line1: '12, Road No. 3, Banjara Hills', city: 'Hyderabad', pincode: '500034' };
let restaurant;
let items;

async function newCustomer(label) {
  const email = `pay-${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
  await api('POST', '/auth/register', { body: { name: `Pay ${label}`, email, password: 'Hungry123' } });
  const login = await api('POST', '/auth/login', { body: { email, password: 'Hungry123' } });
  return login.body.data.accessToken;
}

const orderBody = () => ({ restaurantId: restaurant.id, items: [{ menuItemId: items[0].id, quantity: 2 }, { menuItemId: items[1].id, quantity: 1 }], deliveryAddress: address });

/** Places an order, retrying while the Order Service's catalog read model is still syncing (503). */
const placedOrders = [];
async function placeOrder(token) {
  const res = await waitFor(async () => {
    const r = await api('POST', '/orders', { token, body: orderBody() });
    return r.status === 503 ? null : r;
  }, 30_000, 500);
  if (res?.status !== 201) throw new Error(`order failed: ${JSON.stringify(res?.body)}`);
  placedOrders.push(res.body.data.id);
  return res.body.data;
}

const getOrder = (token, id) => api('GET', `/orders/${id}`, { token }).then((r) => r.body.data);
const getPayment = (token, orderId) => api('GET', `/payments/order/${orderId}`, { token });
const waitPayment = (token, orderId, pred, timeoutMs) =>
  waitFor(async () => {
    const r = await getPayment(token, orderId);
    return r.status === 200 && pred(r.body.data) ? r.body.data : null;
  }, timeoutMs);
const waitOrder = (token, orderId, pred, timeoutMs) =>
  waitFor(async () => {
    const o = await getOrder(token, orderId);
    return o && pred(o) ? o : null;
  }, timeoutMs);
const initiateOnce = (token, orderId) => api('POST', '/payments/initiate', { token, body: { orderId } });
/** Like a real client: while Billing has not finalized the amount (409 BILLING_PENDING), retry after Retry-After. */
async function initiate(token, orderId, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const r = await initiateOnce(token, orderId);
    if (r.body?.error?.code !== 'BILLING_PENDING' || Date.now() - start > timeoutMs) return r;
    await sleep(Number(r.headers.get('retry-after') ?? 1) * 1000);
  }
}
const simulate = (token, paymentId, outcome, deliveries = 1) => api('POST', `/payments/${paymentId}/simulate`, { token, body: { outcome, deliveries } });
const rupees = (p) => `₹${(p / 100).toFixed(2)}`;

function compose(cmd, env = {}) {
  execSync(`docker compose ${cmd}`, { stdio: 'ignore', env: { ...process.env, ...env } });
}

async function waitHealthy(svc) {
  return waitFor(async () => (await api('GET', `/health/${svc}`)).status === 200, 90_000, 1000);
}

async function expiryScenario() {
  console.log(`\nScenario 6 — automatic expiration of unpaid orders (deadline ${SHORT_DEADLINE_S}s for this run)`);
  compose('up -d order-service', { ORDER_PAYMENT_DEADLINE_SECONDS: String(SHORT_DEADLINE_S), EXPIRY_SWEEP_INTERVAL_MS: '1000' });
  await waitHealthy('order');
  try {
    const t = await newCustomer('expiry');
    // (a) never paid
    const a = await placeOrder(t);
    check('order carries expiresAt = createdAt + deadline', new Date(a.expiresAt) - new Date(a.createdAt) === SHORT_DEADLINE_S * 1000, a);
    await waitPayment(t, a.id, () => true);
    // (b) initiated but abandoned (open PaymentIntent)
    const b = await placeOrder(t);
    await waitPayment(t, b.id, () => true);
    const ib = await initiate(t, b.id);
    check('payment initiated before the deadline', ib.status === 201, ib.body);
    // (c) paid in time
    const c = await placeOrder(t);
    await waitPayment(t, c.id, () => true);
    const ic = await initiate(t, c.id);
    await simulate(t, ic.body.data.payment.id, 'succeed');
    await waitOrder(t, c.id, (o) => o.status === 'confirmed');

    const ea = await waitOrder(t, a.id, (o) => o.status === 'expired', 60_000);
    check('unpaid order expired by the worker (record kept, history entry)', ea?.statusHistory.at(-1).by === 'expiration-worker' && !!ea.expiredAt, ea);
    const evt = await waitForEvent(a.id, 'order.expired.v1');
    check('order.expired.v1 published', evt?.body.data.paymentStatus === 'pending', evt?.body);
    const pa = await waitPayment(t, a.id, (p) => p.status === 'cancelled');
    check('payment record cancelled (orderClosure=expired)', pa?.orderClosure === 'expired', pa);
    const late = await initiate(t, a.id);
    check('payment attempt on expired order → 409 ORDER_EXPIRED', late.status === 409 && late.body.error.code === 'ORDER_EXPIRED', late.body);

    await waitOrder(t, b.id, (o) => o.status === 'expired', 60_000);
    const pb = await waitPayment(t, b.id, (p) => p.status === 'cancelled', 30_000);
    check('open PaymentIntent cancelled after expiry', !!pb, pb);
    check('paying the expired order is impossible', (await simulate(t, ib.body.data.payment.id, 'succeed')).status === 409);
    const ob = await waitOrder(t, b.id, (o) => o.paymentStatus === 'cancelled');
    check('order converges: expired / paymentStatus=cancelled', !!ob, ob);

    await sleep(2000);
    const oc = await getOrder(t, c.id);
    check('order paid before the deadline is not expired', oc.status === 'confirmed' && oc.paymentStatus === 'paid', oc);
    check('no order.expired event for the paid order', !(await eventsFor(c.id)).some((e) => e.key === 'order.expired.v1'));
    check('cancelling an expired order → 409', (await api('POST', `/orders/${a.id}/cancel`, { token: t, body: { reason: 'too late' } })).status === 409);
    console.log('  — worker restart: orders that fall due while order-service is down');
    const d = await placeOrder(t);
    compose('stop order-service');
    await sleep((SHORT_DEADLINE_S + 2) * 1000);
    compose('up -d order-service', { ORDER_PAYMENT_DEADLINE_SECONDS: String(SHORT_DEADLINE_S), EXPIRY_SWEEP_INTERVAL_MS: '1000' });
    await waitHealthy('order');
    const od = await waitOrder(t, d.id, (o) => o.status === 'expired', 30_000);
    check('restarted worker expires overdue orders', !!od, od);
    await sleep(3000);
    check('exactly one order.expired event per order', (await eventsFor(d.id)).filter((e) => e.key === 'order.expired.v1').length === 1 && (await eventsFor(a.id)).filter((e) => e.key === 'order.expired.v1').length === 1);
  } finally {
    console.log('  restoring order-service defaults…');
    compose('up -d order-service');
    await waitHealthy('order');
  }
}

// ------------------------------------------------------------------ scenarios
async function main() {
  await rabbit('PUT', `/queues/%2F/${INSPECT}`, { durable: true, auto_delete: false });
  for (const key of ['order.#', 'payment.#']) await rabbit('POST', `/bindings/%2F/e/food.events/q/${INSPECT}`, { routing_key: key });

  const health = await api('GET', '/health/payment');
  check('payment-service healthy', health.status === 200 && health.body.status === 'ok', health.body);
  const list = await api('GET', '/restaurants?search=spice%20route');
  restaurant = list.body.data[0];
  items = (await api('GET', `/restaurants/${restaurant.id}/menu?availableOnly=true`)).body.data.items;

  // ================================================================ 1
  console.log('\nScenario 1 — successful payment');
  const t1 = await newCustomer('success');
  check('customer registered + logged in (JWT)', typeof t1 === 'string');
  const o1 = await placeOrder(t1);
  check(`order placed ${o1.orderNumber} (${rupees(o1.provisionalTotal)})`, o1.status === 'pending_payment');
  const rec1 = await waitPayment(t1, o1.id, (p) => p.amount != null);
  check('payment record created; amount set from the Billing invoice', rec1?.status === 'pending' && rec1.amount === o1.provisionalTotal && !!rec1.invoiceId, rec1);
  const i1 = await initiate(t1, o1.id);
  check('payment initiated → PaymentIntent + client secret', i1.status === 201 && /^pi_/.test(i1.body.data.paymentIntentId) && !!i1.body.data.clientSecret, i1.body);
  console.log(`     provider=${i1.body.data.provider} intent=${i1.body.data.paymentIntentId} amount=${rupees(i1.body.data.payment.amount)}`);
  const tampered = await api('POST', '/payments/initiate', { token: t1, body: { orderId: o1.id, amount: 100 } });
  check('client-supplied amount rejected → 400', tampered.status === 400, tampered.body);
  check('customer simulates card payment → 202', (await simulate(t1, i1.body.data.payment.id, 'succeed')).status === 202);
  const paid1 = await waitPayment(t1, o1.id, (p) => p.status === 'succeeded');
  check('payment succeeded (via signed webhook)', !!paid1, paid1);
  check('payment.succeeded.v1 published', !!(await waitForEvent(o1.id, 'payment.succeeded.v1')));
  const ord1 = await waitOrder(t1, o1.id, (o) => o.status === 'confirmed');
  check('Order Service confirmed order + paymentStatus=paid', ord1?.paymentStatus === 'paid', ord1);
  check('order status history shows system confirmation', ord1?.statusHistory.at(-1).role === 'system');
  const other = await newCustomer('intruder');
  check('another customer cannot see this payment → 404', (await getPayment(other, o1.id)).status === 404);

  // ================================================================ 2
  console.log('\nScenario 2 — failed payment, then retry');
  const t2 = await newCustomer('failure');
  const o2 = await placeOrder(t2);
  await waitPayment(t2, o2.id, () => true);
  const i2 = await initiate(t2, o2.id);
  await simulate(t2, i2.body.data.payment.id, 'fail');
  const f2 = await waitPayment(t2, o2.id, (p) => p.status === 'failed');
  check('payment failed (card declined)', !!f2 && f2.lastFailure?.code === 'generic_decline', f2);
  const fe2 = await waitForEvent(o2.id, 'payment.failed.v1');
  check('payment.failed.v1 published (retryable)', fe2?.body.data.retryable === true, fe2?.body);
  const ord2 = await waitOrder(t2, o2.id, (o) => o.paymentStatus === 'failed');
  check('order remains unpaid: pending_payment / paymentStatus=failed', ord2?.status === 'pending_payment', ord2);
  const r2 = await initiate(t2, o2.id);
  check('retry reuses the same PaymentIntent (no second charge)', r2.status === 200 && r2.body.data.paymentIntentId === i2.body.data.paymentIntentId, r2.body);
  await simulate(t2, i2.body.data.payment.id, 'succeed');
  const ord2b = await waitOrder(t2, o2.id, (o) => o.status === 'confirmed');
  check('retry succeeds → order confirmed', ord2b?.paymentStatus === 'paid', ord2b);

  // ================================================================ 3
  console.log('\nScenario 3 — cancellation and refund');
  const t3 = await newCustomer('refund');
  const o3 = await placeOrder(t3);
  await waitPayment(t3, o3.id, () => true);
  const i3 = await initiate(t3, o3.id);
  await simulate(t3, i3.body.data.payment.id, 'succeed');
  await waitOrder(t3, o3.id, (o) => o.status === 'confirmed');
  const c3 = await api('POST', `/orders/${o3.id}/cancel`, { token: t3, body: { reason: 'Ordered from the wrong restaurant' } });
  check('customer cancels paid order → refund_pending on order', c3.body.data?.status === 'cancelled' && c3.body.data.paymentStatus === 'refund_pending', c3.body);
  const p3 = await waitPayment(t3, o3.id, (p) => p.status === 'refunded');
  check('refund confirmed by provider → payment refunded', p3?.refundedAmount === o3.provisionalTotal && p3.refunds.length === 1, p3);
  const re3 = await waitForEvent(o3.id, 'payment.refund.completed.v1');
  check('payment.refund.completed.v1 published (full)', re3?.body.data.fullyRefunded === true && re3.body.data.amount === o3.provisionalTotal, re3?.body);
  const ord3 = await waitOrder(t3, o3.id, (o) => o.paymentStatus === 'refunded');
  check('order converges: cancelled / paymentStatus=refunded', ord3?.status === 'cancelled', ord3);

  console.log('  — cancellation before payment completes');
  const t3b = await newCustomer('cancel-early');
  const o3b = await placeOrder(t3b);
  await waitPayment(t3b, o3b.id, () => true);
  const i3b = await initiate(t3b, o3b.id);
  await api('POST', `/orders/${o3b.id}/cancel`, { token: t3b, body: { reason: 'Changed my mind' } });
  const p3b = await waitPayment(t3b, o3b.id, (p) => p.status === 'cancelled');
  check('open PaymentIntent cancelled at provider → payment cancelled', !!p3b, p3b);
  check('payment.cancelled.v1 published', !!(await waitForEvent(o3b.id, 'payment.cancelled.v1')));
  const ord3b = await waitOrder(t3b, o3b.id, (o) => o.paymentStatus === 'cancelled');
  check('order paymentStatus=cancelled', !!ord3b, ord3b);
  check('cannot pay a cancelled order', (await simulate(t3b, i3b.body.data.payment.id, 'succeed')).status === 409);

  console.log('  — refund failure');
  const t3c = await newCustomer('refund-fails');
  const o3c = await placeOrder(t3c);
  await waitPayment(t3c, o3c.id, () => true);
  const i3c = await initiate(t3c, o3c.id);
  await simulate(t3c, i3c.body.data.payment.id, 'succeed_refund_fails');
  await waitOrder(t3c, o3c.id, (o) => o.status === 'confirmed');
  await api('POST', `/orders/${o3c.id}/cancel`, { token: t3c, body: { reason: 'Card closed test' } });
  const p3c = await waitPayment(t3c, o3c.id, (p) => p.refundStatus === 'failed');
  check('refund failure recorded (payment stays captured, refundStatus=failed)', p3c?.status === 'succeeded' && p3c.refunds[0]?.status === 'failed', p3c);
  check('payment.refund.failed.v1 published', !!(await waitForEvent(o3c.id, 'payment.refund.failed.v1')));
  const ord3c = await waitOrder(t3c, o3c.id, (o) => o.paymentStatus === 'refund_failed');
  check('order paymentStatus=refund_failed (needs manual follow-up)', !!ord3c, ord3c);

  // ================================================================ 4
  console.log('\nScenario 4 — duplicate events and requests');
  const t4 = await newCustomer('dupes');
  const o4 = await placeOrder(t4);
  await waitPayment(t4, o4.id, () => true);
  const created4 = await waitForEvent(o4.id, 'order.created.v1');
  for (let i = 0; i < 3; i++) {
    await rabbit('POST', '/exchanges/%2F/food.events/publish', {
      routing_key: created4.key,
      payload: JSON.stringify(created4.body),
      payload_encoding: 'string',
      properties: { delivery_mode: 2, message_id: created4.body.eventId, content_type: 'application/json' },
    });
  }
  await sleep(1500);
  const adminTok = (await api('POST', '/auth/login', { body: { email: process.env.ADMIN_EMAIL ?? 'admin@food.local', password: process.env.ADMIN_PASSWORD ?? 'Admin@12345' } })).body.data.accessToken;
  const count4 = await api('GET', `/payments?orderId=${o4.id}`, { token: adminTok });
  check('order.created redelivered 3× → still exactly one payment record', count4.body.meta?.total === 1, count4.body);
  const [a4, b4] = await Promise.all([initiate(t4, o4.id), initiate(t4, o4.id)]);
  check('concurrent initiations → one PaymentIntent', a4.body.data?.paymentIntentId && a4.body.data.paymentIntentId === b4.body.data?.paymentIntentId, [a4.body, b4.body]);
  await simulate(t4, a4.body.data.payment.id, 'succeed', 3); // same signed webhook delivered 3×
  const p4 = await waitPayment(t4, o4.id, (p) => p.status === 'succeeded');
  await sleep(1500);
  const ev4 = await eventsFor(o4.id);
  check('success webhook delivered 3× → one payment.succeeded event', ev4.filter((e) => e.key === 'payment.succeeded.v1').length === 1, ev4.map((e) => e.key));
  check('single "succeeded" entry in payment history', p4?.statusHistory.filter((s) => s.status === 'succeeded').length === 1, p4?.statusHistory);
  const ord4 = await getOrder(t4, o4.id);
  check('single confirmation in order history', ord4.statusHistory.filter((s) => s.status === 'confirmed').length === 1, ord4.statusHistory);
  await api('POST', `/orders/${o4.id}/cancel`, { token: t4, body: { reason: 'Duplicate cancel test' } });
  const cancel4 = await waitForEvent(o4.id, 'order.cancelled.v1');
  for (let i = 0; i < 2; i++) {
    await rabbit('POST', '/exchanges/%2F/food.events/publish', { routing_key: cancel4.key, payload: JSON.stringify(cancel4.body), payload_encoding: 'string', properties: { delivery_mode: 2 } });
  }
  const p4b = await waitPayment(t4, o4.id, (p) => p.status === 'refunded');
  await sleep(1500);
  check('order.cancelled redelivered → exactly one refund', p4b?.refunds.length === 1, p4b?.refunds);
  check('exactly one payment.refund.completed event', (await eventsFor(o4.id)).filter((e) => e.key === 'payment.refund.completed.v1').length === 1);
  const key4 = `e2e-refund-${randomUUID()}`;
  const manual = await api('POST', `/payments/${p4b.id}/refund`, { token: adminTok, headers: { 'idempotency-key': key4 }, body: { reason: 'Already refunded' } });
  check('admin refund of a fully refunded payment → 409', manual.status === 409, manual.body);
  const forged = await fetch(`${GATEWAY}/payments/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: '{"id":"evt_forged","type":"payment_intent.succeeded"}' });
  check('forged webhook rejected → 400', forged.status === 400);

  if (EXPIRY) await expiryScenario();
  else console.log('\nScenario 6 — skipped (run with --expiry)');

  // ================================================================ 5
  if (!RESILIENCE) {
    console.log('\nScenario 5 — skipped (run with --resilience)');
    return;
  }
  console.log('\nScenario 5 — infrastructure failure');
  const t5 = await newCustomer('outage');
  // Placed and billed before the outage (services learn about orders only through events).
  const o5 = await placeOrder(t5);
  const i5 = await initiate(t5, o5.id);
  check('payment initiated once the bill is finalized', i5.status === 201, i5.body);
  console.log('  stopping RabbitMQ…');
  compose('stop rabbitmq');
  await sleep(3000);
  const h5 = await api('GET', '/health/payment');
  check('payment-service degraded but up during outage', h5.status === 200 && h5.body.checks.rabbitmq === 'down', h5.body);
  const blocked = await api('POST', '/orders', { token: t5, body: orderBody() });
  check(
    'new order refused during outage instead of using possibly stale prices (503 CATALOG_SYNC_UNAVAILABLE)',
    blocked.status === 503 && blocked.body.error.code === 'CATALOG_SYNC_UNAVAILABLE',
    blocked.body,
  );
  await simulate(t5, i5.body.data.payment.id, 'succeed');
  const p5 = await waitPayment(t5, o5.id, (p) => p.status === 'succeeded');
  check('payment succeeds during outage (webhooks do not need RabbitMQ)', !!p5);
  const o5mid = await getOrder(t5, o5.id);
  check('order not yet confirmed (event waiting in payment outbox)', o5mid.status === 'pending_payment', o5mid);
  console.log('  starting RabbitMQ…');
  compose('start rabbitmq');
  const o5done = await waitOrder(t5, o5.id, (o) => o.status === 'confirmed', 90_000);
  check('after recovery: outbox flushed → order confirmed', o5done?.paymentStatus === 'paid', o5done);

  const t6 = await newCustomer('restart');
  const o6 = await placeOrder(t6);
  await waitPayment(t6, o6.id, () => true);
  const i6 = await initiate(t6, o6.id);
  console.log('  restarting payment-service…');
  compose('restart payment-service');
  await waitFor(async () => (await api('GET', '/health/payment')).status === 200, 60_000, 1000);
  const p6 = await getPayment(t6, o6.id);
  check('payment state persisted across restart', p6.body.data?.status === 'requires_action' && p6.body.data.providerPaymentIntentId === i6.body.data.paymentIntentId, p6.body);
  const again6 = await initiate(t6, o6.id);
  check('same PaymentIntent after restart', again6.body.data?.paymentIntentId === i6.body.data.paymentIntentId, again6.body);
  await simulate(t6, i6.body.data.payment.id, 'succeed');
  const o6done = await waitOrder(t6, o6.id, (o) => o.status === 'confirmed', 30_000);
  check('payment completes after restart → order confirmed', !!o6done, o6done);
}

/**
 * Test hygiene (Stage 6): paid orders now get real deliveries that reserve a delivery partner until pickup.
 * Orders this run left awaiting pickup are cancelled by a platform admin (refunded through the normal flow),
 * so the shared partner pool is free for the next suite.
 */
async function releaseOpenDeliveries() {
  const login = await api('POST', '/auth/login', { body: { email: process.env.ADMIN_EMAIL ?? 'admin@food.local', password: process.env.ADMIN_PASSWORD ?? 'Admin@12345' } });
  const token = login.body?.data?.accessToken;
  if (!token) return;
  let n = 0;
  for (const id of placedOrders) {
    const o = (await api('GET', `/orders/${id}`, { token })).body?.data;
    if (o && ['confirmed', 'assigning_delivery_partner', 'partner_assigned'].includes(o.status)) {
      if ((await api('POST', `/orders/${id}/cancel`, { token, body: { reason: 'E2E cleanup: release delivery partner' } })).status === 200) n++;
    }
  }
  if (n) console.log(`\n(cleanup: cancelled ${n} paid order(s) still awaiting pickup, releasing their delivery partners)`);
}

try {
  await main();
  await releaseOpenDeliveries();
} catch (err) {
  failed++;
  console.error('\nPayment E2E crashed:', err);
} finally {
  await rabbit('DELETE', `/queues/%2F/${INSPECT}`).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
