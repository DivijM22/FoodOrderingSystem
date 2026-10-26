#!/usr/bin/env node
/**
 * Stage 5 end-to-end billing scenarios against the running Docker Compose stack (via the gateway).
 *
 *   node scripts/e2e-billing.mjs                 # billing scenarios
 *   node scripts/e2e-billing.mjs --expiry        # + invoice voided by order expiry (12 s deadline, restored after)
 *   node scripts/e2e-billing.mjs --resilience    # + Billing Service down / delayed billing events
 *
 * Payments use the stack's provider (mock by default — simulated, not Stripe).
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const RABBIT = process.env.RABBITMQ_API ?? 'http://localhost:15672';
const RABBIT_AUTH = 'Basic ' + Buffer.from(`${process.env.RABBITMQ_USER ?? 'food'}:${process.env.RABBITMQ_PASSWORD ?? 'food-dev-password'}`).toString('base64');
const INSPECT = `e2e.billing.${randomUUID().slice(0, 8)}`;
const EXPIRY = process.argv.includes('--expiry');
const RESILIENCE = process.argv.includes('--resilience');

let passed = 0;
let failed = 0;
function check(name, ok, info) {
  if (ok) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 600) : '');
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20_000, everyMs = 300) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(everyMs);
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
      if (attempt >= 10) throw err;
      await sleep(1000);
    }
  }
}
async function rabbit(method, path, body) {
  const res = await fetch(`${RABBIT}/api${path}`, { method, headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
const events = [];
async function eventsFor(orderId) {
  for (;;) {
    const got = await rabbit('POST', `/queues/%2F/${INSPECT}/get`, { count: 200, ackmode: 'ack_requeue_false', encoding: 'auto' }).catch(() => []);
    if (!Array.isArray(got) || !got.length) break;
    for (const m of got) events.push({ key: m.routing_key, body: JSON.parse(m.payload) });
  }
  return events.filter((e) => e.body.data?.orderId === orderId);
}
const waitForEvent = (orderId, key, t) => waitFor(async () => (await eventsFor(orderId)).find((e) => e.key === key), t);
const compose = (cmd, env = {}) => execSync(`docker compose ${cmd}`, { stdio: 'ignore', env: { ...process.env, ...env } });
const rupees = (p) => `₹${(p / 100).toFixed(2)}`;

let restaurant;
let items;
let admin;
const address = { line1: '12, Road No. 3, Banjara Hills', city: 'Hyderabad', pincode: '500034' };

async function newCustomer(label) {
  const email = `bill-${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
  await api('POST', '/auth/register', { body: { name: `Bill ${label}`, email, password: 'Hungry123' } });
  return (await api('POST', '/auth/login', { body: { email, password: 'Hungry123' } })).body.data.accessToken;
}
const orderBody = (extra = {}) => ({ restaurantId: restaurant.id, items: [{ menuItemId: items[0].id, quantity: 2 }, { menuItemId: items[1].id, quantity: 1 }], deliveryAddress: address, ...extra });
/** Retries while the Order Service's catalog read model is still syncing (503 CATALOG_SYNC_PENDING). */
const placedOrders = [];
async function placeOrder(token, extra = {}) {
  const res = await waitFor(async () => {
    const r = await api('POST', '/orders', { token, body: orderBody(extra) });
    return r.status === 503 ? null : r;
  }, 30_000);
  if (res?.status !== 201) throw new Error(`order failed: ${JSON.stringify(res?.body)}`);
  placedOrders.push(res.body.data.id);
  return res.body.data;
}
const invoice = (token, orderId) => api('GET', `/invoices/order/${orderId}`, { token }).then((r) => (r.status === 200 ? r.body.data : null));
const waitInvoice = (token, orderId, pred = () => true, t) => waitFor(async () => { const i = await invoice(token, orderId); return i && pred(i) ? i : null; }, t);
const getOrder = (token, id) => api('GET', `/orders/${id}`, { token }).then((r) => r.body.data);
const waitOrder = (token, id, pred, t) => waitFor(async () => { const o = await getOrder(token, id); return o && pred(o) ? o : null; }, t);
const initiateOnce = (token, orderId) => api('POST', '/payments/initiate', { token, body: { orderId } });
/** Like a real client: retries 409 BILLING_PENDING (amount not finalized yet) after Retry-After. */
async function initiate(token, orderId, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const r = await initiateOnce(token, orderId);
    if (r.body?.error?.code !== 'BILLING_PENDING' || Date.now() - start > timeoutMs) return r;
    await sleep(Number(r.headers?.get('retry-after') ?? 1) * 1000);
  }
}
const simulate = (token, paymentId, outcome = 'succeed') => api('POST', `/payments/${paymentId}/simulate`, { token, body: { outcome } });

async function payAndConfirm(token, o) {
  const i = await initiate(token, o.id);
  await simulate(token, i.body.data.payment.id);
  await waitOrder(token, o.id, (x) => x.status === 'confirmed');
  return i;
}

async function main() {
  await rabbit('PUT', `/queues/%2F/${INSPECT}`, { durable: true, auto_delete: false });
  for (const key of ['order.#', 'payment.#', 'billing.#']) await rabbit('POST', `/bindings/%2F/e/food.events/q/${INSPECT}`, { routing_key: key });

  const h = await api('GET', '/health/billing');
  check('billing-service healthy', h.status === 200 && h.body.status === 'ok', h.body);
  restaurant = (await api('GET', '/restaurants?search=spice%20route')).body.data[0];
  items = (await api('GET', `/restaurants/${restaurant.id}/menu?availableOnly=true`)).body.data.items;
  admin = (await api('POST', '/auth/login', { body: { email: process.env.ADMIN_EMAIL ?? 'admin@food.local', password: process.env.ADMIN_PASSWORD ?? 'Admin@12345' } })).body.data.accessToken;

  console.log('\nB1 — promo codes');
  const promos = await api('GET', '/discounts');
  const codes = promos.body.data.map((d) => d.code);
  check('public list shows active codes only', codes.includes('FEAST20') && !codes.includes('MONSOON15') && !codes.includes('PAUSED25'), codes);

  console.log('\nB2 — itemised invoice + discount → payment charges the invoice amount');
  const t1 = await newCustomer('discount');
  const o1 = await placeOrder(t1, { discountCode: 'feast20' });
  const inv1 = await waitInvoice(t1, o1.id);
  const expectedDiscount = Math.min(Math.floor((o1.subtotal * 20) / 100), 15000);
  check('invoice issued from order.created (itemised)', inv1?.lines.filter((l) => l.kind === 'item').length === o1.items.length, inv1);
  check(`FEAST20 applied: −${rupees(expectedDiscount)}`, inv1?.discount?.code === 'FEAST20' && inv1.discountAmount === expectedDiscount, inv1);
  check('taxAmount = 0, finalAmount = subtotal − discount', inv1?.taxAmount === 0 && inv1.taxLines.length === 0 && inv1.finalAmount === inv1.subtotal - inv1.discountAmount, inv1);
  check('subtotal verified = items + delivery fee = order provisional total', inv1?.subtotal === o1.provisionalTotal && inv1.itemsSubtotal === o1.subtotal, { inv1, o1 });
  console.log(`     ${inv1.invoiceNumber}: subtotal ${rupees(inv1.subtotal)} − discount ${rupees(inv1.discountAmount)} + tax ₹0.00 = ${rupees(inv1.finalAmount)}`);
  check('billing.finalized.v1 published', (await waitForEvent(o1.id, 'billing.finalized.v1'))?.body.data.finalAmount === inv1.finalAmount);
  const ord1 = await waitOrder(t1, o1.id, (o) => o.billing);
  check('Order Service mirrors the final payable amount', ord1?.billing.finalAmount === inv1.finalAmount && ord1.billing.invoiceNumber === inv1.invoiceNumber, ord1?.billing);
  const i1 = await initiate(t1, o1.id);
  check('payment amount = invoice finalAmount (not the provisional total)', i1.body.data?.payment.amount === inv1.finalAmount && i1.body.data.payment.amount !== o1.provisionalTotal && i1.body.data.payment.invoiceId === inv1.id, i1.body);
  await simulate(t1, i1.body.data.payment.id);
  const conf1 = await waitOrder(t1, o1.id, (o) => o.status === 'confirmed');
  check('discounted payment confirms the order', conf1?.paymentStatus === 'paid', conf1);
  const succ1 = await waitForEvent(o1.id, 'payment.succeeded.v1');
  check('payment.succeeded carries the invoice id and amount', succ1?.body.data.amount === inv1.finalAmount && succ1.body.data.invoiceId === inv1.id, succ1?.body);
  const paid1 = await waitInvoice(t1, o1.id, (i) => i.status === 'paid');
  check('invoice status derived from ledger: paid', paid1?.amountPaid === inv1.finalAmount && paid1.amountDue === 0, paid1);
  check('no API can modify an invoice (PATCH → 404)', (await api('PATCH', `/invoices/${inv1.id}`, { token: admin, body: { finalAmount: 1 } })).status === 404);

  console.log('\nB3 — invalid code is reported, full price charged');
  const t2 = await newCustomer('badcode');
  const o2 = await placeOrder(t2, { discountCode: 'MONSOON15' });
  const inv2 = await waitInvoice(t2, o2.id);
  check('expired code not applied, reason recorded', inv2?.discountAmount === 0 && inv2.discountRejection?.reason === 'EXPIRED' && inv2.finalAmount === o2.provisionalTotal, inv2);
  check('another customer cannot read the invoice', (await api('GET', `/invoices/order/${o2.id}`, { token: t1 })).status === 404);

  console.log('\nB4 — refund adjustment after cancellation');
  const t3 = await newCustomer('refund');
  const o3 = await placeOrder(t3, { discountCode: 'WELCOME50' });
  const inv3 = await waitInvoice(t3, o3.id);
  await payAndConfirm(t3, o3);
  await api('POST', `/orders/${o3.id}/cancel`, { token: t3, body: { reason: 'Changed plans' } });
  const ref3 = await waitInvoice(t3, o3.id, (i) => i.status === 'refunded', 30_000);
  const cn = ref3?.adjustments.find((a) => a.kind === 'refund');
  check('refund recorded as a credit note for the invoice amount', cn?.amount === inv3.finalAmount && /^CN-/.test(cn.documentNumber), ref3?.adjustments);
  check('invoice unchanged (immutable): same finalAmount, ledger shows payment + refund + closure', ref3?.finalAmount === inv3.finalAmount && ref3.netCollected === 0 && ref3.adjustments.some((a) => a.kind === 'closure'), ref3);
  const ord3 = await waitOrder(t3, o3.id, (o) => o.paymentStatus === 'refunded');
  check('order converges: cancelled / refunded', ord3?.status === 'cancelled', ord3);

  console.log('\nB5 — cancellation before payment voids the invoice');
  const t4 = await newCustomer('void');
  const o4 = await placeOrder(t4);
  await waitInvoice(t4, o4.id);
  await api('POST', `/orders/${o4.id}/cancel`, { token: t4, body: { reason: 'Ordered twice' } });
  const v4 = await waitInvoice(t4, o4.id, (i) => i.status === 'void');
  check('invoice void, nothing due', v4?.amountDue === 0 && v4.amountPaid === 0, v4);

  console.log('\nB6 — duplicate events');
  const t5 = await newCustomer('dupes');
  const o5 = await placeOrder(t5);
  await waitInvoice(t5, o5.id);
  await payAndConfirm(t5, o5);
  await waitInvoice(t5, o5.id, (i) => i.status === 'paid');
  const created5 = await waitForEvent(o5.id, 'order.created.v1');
  const paid5 = await waitForEvent(o5.id, 'payment.succeeded.v1');
  for (const e of [created5, created5, paid5, paid5]) {
    await rabbit('POST', '/exchanges/%2F/food.events/publish', { routing_key: e.key, payload: JSON.stringify(e.body), payload_encoding: 'string', properties: { delivery_mode: 2 } });
  }
  // A distinct event (new id) describing the same payment must not double-count either.
  await rabbit('POST', '/exchanges/%2F/food.events/publish', { routing_key: paid5.key, payload: JSON.stringify({ ...paid5.body, eventId: randomUUID() }), payload_encoding: 'string', properties: { delivery_mode: 2 } });
  await sleep(2500);
  const list5 = await api('GET', `/invoices?orderId=${o5.id}`, { token: admin });
  check('order.created redelivered → still one invoice', list5.body.meta?.total === 1, list5.body.meta);
  const inv5 = await invoice(t5, o5.id);
  check('payment.succeeded redelivered (and re-sent with a new id) → one payment entry', inv5.adjustments.filter((a) => a.kind === 'payment').length === 1 && inv5.amountPaid === inv5.finalAmount, inv5.adjustments);
  check('one billing.finalized event for the order', (await eventsFor(o5.id)).filter((e) => e.key === 'billing.finalized.v1').length === 1);

  if (EXPIRY) {
    console.log('\nB7 — expiry voids the invoice (order-service temporarily on a 12 s deadline)');
    compose('up -d order-service', { ORDER_PAYMENT_DEADLINE_SECONDS: '12', EXPIRY_SWEEP_INTERVAL_MS: '1000' });
    await waitFor(async () => (await api('GET', '/health/order')).status === 200, 90_000, 1000);
    try {
      const t6 = await newCustomer('expiry');
      const o6 = await placeOrder(t6);
      await waitInvoice(t6, o6.id);
      const exp = await waitOrder(t6, o6.id, (o) => o.status === 'expired', 60_000);
      check('order expired (15-minute mechanism preserved; shortened for the test)', !!exp, exp);
      const v6 = await waitInvoice(t6, o6.id, (i) => i.status === 'void', 30_000);
      check('invoice voided by order.expired', v6?.adjustments.some((a) => a.kind === 'closure' && /expired/i.test(a.reason)), v6);
      const late = await initiate(t6, o6.id);
      check('payment refused → 409 ORDER_EXPIRED', late.status === 409 && late.body.error.code === 'ORDER_EXPIRED', late.body);
    } finally {
      compose('up -d order-service');
      await waitFor(async () => (await api('GET', '/health/order')).status === 200, 90_000, 1000);
    }
  }

  if (RESILIENCE) {
    console.log('\nB8 — Billing Service down: delayed billing events');
    const t7 = await newCustomer('billing-down');
    compose('stop billing-service');
    await sleep(2000);
    const o7 = await placeOrder(t7, { discountCode: 'WELCOME50' });
    check('orders still accepted while billing is down', o7.status === 'pending_payment');
    const down = await initiateOnce(t7, o7.id);
    check(
      'payment not started while the amount is not finalized (409 BILLING_PENDING + Retry-After, nothing charged)',
      down.status === 409 && down.body.error.code === 'BILLING_PENDING' && !!down.headers.get('retry-after'),
      down.body,
    );
    compose('start billing-service');
    await waitFor(async () => (await api('GET', '/health/billing')).status === 200, 90_000, 1000);
    const inv7 = await waitInvoice(t7, o7.id, () => true, 30_000);
    check('queued order.created processed after restart → invoice with discount', inv7?.discountAmount === 5000, inv7);
    const ok7 = await initiate(t7, o7.id);
    check('payment then charges the invoice amount', ok7.body.data?.payment.amount === inv7?.finalAmount, ok7.body);

    console.log('\nB9 — RabbitMQ down: no synchronous fallback, consistency after recovery');
    const t8 = await newCustomer('broker-down');
    // Keep order.created from reaching Billing: Billing down while the order is placed, then the broker goes down.
    compose('stop billing-service');
    await sleep(2000);
    const o8 = await placeOrder(t8, { discountCode: 'FLAT100' });
    compose('stop rabbitmq');
    await sleep(3000);
    // `docker compose start` would also start the rabbitmq dependency; start only the container.
    execSync('docker start $(docker compose ps -a -q billing-service)', { stdio: 'ignore' });
    await waitFor(async () => (await api('GET', '/health/billing')).status === 200, 90_000, 1000);
    const blocked = await api('POST', '/orders', { token: t8, body: orderBody() });
    check('new orders refused while catalog freshness cannot be guaranteed (503 CATALOG_SYNC_UNAVAILABLE)', blocked.status === 503 && blocked.body.error?.code === 'CATALOG_SYNC_UNAVAILABLE', blocked.body);
    const i8 = await initiateOnce(t8, o8.id);
    check('payment waits for the finalized bill (409 BILLING_PENDING; Payment never calls Billing)', i8.status === 409 && i8.body.error.code === 'BILLING_PENDING', i8.body);
    check('no invoice issued without the event', (await invoice(t8, o8.id)) === null);
    compose('start rabbitmq');
    await waitFor(async () => (await api('GET', '/health/order')).body?.checks?.rabbitmq === 'up', 90_000, 1000);
    const inv8 = await waitInvoice(t8, o8.id, () => true, 60_000);
    check('after recovery: order.created delivered → invoice with FLAT100', inv8?.discountAmount === 10000, inv8);
    const ok8 = await initiate(t8, o8.id, 30_000);
    check('payment then charges the finalized amount', ok8.status === 201 && ok8.body.data.payment.amount === inv8?.finalAmount, ok8.body);
    const list8 = await api('GET', `/invoices?orderId=${o8.id}`, { token: admin });
    check('exactly one invoice', list8.body.meta?.total === 1, list8.body.meta);
  }
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
  console.error('\nBilling E2E crashed:', err);
} finally {
  await rabbit('DELETE', `/queues/%2F/${INSPECT}`).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
