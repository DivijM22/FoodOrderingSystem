#!/usr/bin/env node
/**
 * Notification Service end-to-end test against the running Docker Compose stack.
 *   docker compose up -d --build && node scripts/e2e-notifications.mjs [--resilience] [--expiry]
 *
 * Emails are captured by Mailpit (http://localhost:8025) and inspected through its REST API.
 * Nothing is sent to a real mailbox. The delivery phase is driven for real (seeded delivery partners pick
 * up, arrive and verify the OTP read from Mailpit). Synthetic delivery events are published only to prove
 * that illegal, stale or conflicting facts are rejected by the Order Service.
 *
 * Env: GATEWAY_URL, RABBITMQ_API, RABBITMQ_USER / RABBITMQ_PASSWORD, MAILPIT_URL.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { env } from './lib-env.mjs';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const RABBIT = process.env.RABBITMQ_API ?? 'http://localhost:15672';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const RABBIT_AUTH = 'Basic ' + Buffer.from(`${process.env.RABBITMQ_USER ?? 'food'}:${process.env.RABBITMQ_PASSWORD ?? 'food-dev-password'}`).toString('base64');
const INSPECT = `e2e.notifications.${randomUUID().slice(0, 8)}`;
const RESILIENCE = process.argv.includes('--resilience');
const EXPIRY = process.argv.includes('--expiry');
const RUN = Date.now().toString(36);

let passed = 0;
let failed = 0;
function check(name, condition, info) {
  if (condition) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : '');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20_000, everyMs = 500) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(everyMs);
  }
}

async function api(method, path, { body, token } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${GATEWAY}${path}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

const publish = (key, envelope) =>
  rabbit('POST', '/exchanges/%2F/food.events/publish', { routing_key: key, payload: JSON.stringify(envelope), payload_encoding: 'string', properties: { delivery_mode: 2, content_type: 'application/json' } });

const queueDepth = async (q) => (await rabbit('GET', `/queues/%2F/${encodeURIComponent(q)}`))?.messages ?? 0;

/** Every order.status_changed.v1 seen during the run (for duplicate re-publication). */
const statusEvents = [];
async function drain() {
  const got = await rabbit('POST', `/queues/%2F/${INSPECT}/get`, { count: 200, ackmode: 'ack_requeue_false', encoding: 'auto' });
  for (const m of got ?? []) statusEvents.push(JSON.parse(m.payload));
}

// ---------------------------------------------------------------- Mailpit

async function mailpit(path, init) {
  const res = await fetch(`${MAILPIT}/api/v1${path}`, init);
  return res.ok ? res.json() : null;
}
/** Messages captured for one recipient (newest first). */
const inbox = async (address) => (await mailpit(`/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=50`))?.messages ?? [];
const message = (id) => mailpit(`/message/${id}`);
const headersOf = (id) => mailpit(`/message/${id}/headers`);
const waitInbox = (address, n, timeoutMs = 20_000) => waitFor(async () => ((await inbox(address)).length >= n ? inbox(address) : null), timeoutMs);

// ---------------------------------------------------------------- platform helpers

function compose(cmd, env = {}) {
  execSync(`docker compose ${cmd}`, { stdio: 'ignore', env: { ...process.env, ...env } });
}
function notificationRecord(recipient) {
  const out = execSync(
    `docker compose exec -T mongo mongosh --quiet notification_db --eval 'JSON.stringify(db.notifications.find({ recipient: ${JSON.stringify(recipient)} }).toArray())'`,
    { encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').at(-1));
}
function notificationHealth() {
  try {
    return JSON.parse(execSync('docker compose exec -T notification-service wget -qO- http://127.0.0.1:4006/health', { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

let restaurant;
let items;
const address = { line1: '7, MG Road', city: 'Bengaluru', pincode: '560001' };

async function newCustomer(label) {
  const email = `notify-${label}-${RUN}@example.com`;
  await api('POST', '/auth/register', { body: { name: `Notify ${label}`, email, password: 'Hungry123' } });
  const login = await api('POST', '/auth/login', { body: { email, password: 'Hungry123' } });
  return { token: login.body.data.accessToken, email };
}
async function placeOrder(token) {
  const res = await waitFor(async () => {
    const r = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ menuItemId: items[0].id, quantity: 2 }, { menuItemId: items[1].id, quantity: 1 }], deliveryAddress: address } });
    return r.status === 503 ? null : r; // catalog read model still syncing
  }, 30_000);
  if (res?.status !== 201) throw new Error(`order failed: ${JSON.stringify(res?.body)}`);
  return res.body.data;
}
const getOrder = (token, id) => api('GET', `/orders/${id}`, { token }).then((r) => r.body.data);
const waitOrder = (token, id, pred, t) => waitFor(async () => { const o = await getOrder(token, id); return o && pred(o) ? o : null; }, t);

async function pay(token, order) {
  let init;
  await waitFor(async () => {
    init = await api('POST', '/payments/initiate', { token, body: { orderId: order.id } });
    return init.body?.error?.code !== 'BILLING_PENDING'; // Billing has not finalized the amount yet
  }, 30_000, 1000);
  if (init.status !== 201) throw new Error(`initiate failed: ${JSON.stringify(init.body)}`);
  await api('POST', `/payments/${init.body.data.payment.id}/simulate`, { token, body: { outcome: 'succeed' } });
  return waitOrder(token, order.id, (o) => o.status === 'confirmed', 30_000);
}

/** A delivery fact as the Delivery Service (Stage 6) will publish it. */
function deliveryEvent(type, orderId, extra = {}) {
  const now = new Date().toISOString();
  const base = { deliveryId: `del_e2e_${orderId.slice(-6)}`, orderId };
  const data = {
    'delivery.ready_for_pickup': { ...base, restaurantId: restaurant.id, readyAt: now },
    'delivery.partner_assigned': { ...base, agentId: 'agent_e2e', agentName: 'Ravi K.', assignedAt: now },
    'delivery.picked_up': { ...base, agentId: 'agent_e2e', pickedUpAt: now },
    'delivery.location_reached': { ...base, agentId: 'agent_e2e', reachedAt: now, otpExpiresAt: new Date(Date.now() + 600_000).toISOString() },
    'delivery.completed': { ...base, agentId: 'agent_e2e', deliveredAt: now, otpVerified: true },
  }[type];
  return { eventId: randomUUID(), eventType: type, version: 1, occurredAt: now, source: 'delivery-service', data: { ...data, ...extra } };
}
const sendDelivery = (type, orderId) => publish(`${type}.v1`, deliveryEvent(type, orderId));
const agentEmail = (name) => `agent.${name.toLowerCase().replaceAll(' ', '.')}@food.local`;

/** Waits for the real assignment and logs in as the assigned partner. */
async function assignedPartner(token, orderId) {
  const t = await waitFor(async () => {
    const r = (await api('GET', `/orders/${orderId}/tracking`, { token })).body.data;
    return r?.status === 'partner_assigned' ? r : null;
  }, 60_000);
  if (!t) throw new Error('no partner assigned');
  const login = await api('POST', '/auth/login', { body: { email: agentEmail(t.deliveryPartner.name), password: env('DELIVERY_AGENT_PASSWORD') } });
  const agentToken = login.body.data.accessToken;
  const delivery = (await api('GET', '/deliveries/agents/me', { token: agentToken })).body.data.activeDelivery;
  return { name: t.deliveryPartner.name, token: agentToken, deliveryId: delivery.id };
}
const agentDo = (agent, action, body) => api('POST', `/deliveries/${agent.deliveryId}/${action}`, { token: agent.token, body });

/** Real partner flow from assignment to verified delivery (OTP read from the customer's email). */
async function completeDelivery(customer, order, agent) {
  await agentDo(agent, 'pickup');
  await agentDo(agent, 'arrived');
  const otpMail = await waitFor(async () => (await inbox(customer.email)).find((m) => /delivery code/i.test(m.Subject)), 45_000);
  const code = /Your delivery code is: (\d{6})/.exec((await message(otpMail?.ID))?.Text ?? '')?.[1];
  const v = await agentDo(agent, 'verify-otp', { otp: code });
  return { code, verified: v.status === 200 };
}

// ---------------------------------------------------------------- scenarios

async function main() {
  console.log(`Gateway: ${GATEWAY}   Mailpit: ${MAILPIT}`);
  check('Mailpit API reachable', !!(await mailpit('/info')));
  const h = notificationHealth();
  check('notification-service healthy (mongo, rabbitmq, smtp up)', h?.status === 'ok' && h.checks.smtp === 'up' && h.checks.rabbitmq === 'up', h);
  check('notification-service is internal (no gateway route)', (await api('GET', '/health/notification')).status === 404);

  await rabbit('PUT', `/queues/%2F/${INSPECT}`, { durable: false, auto_delete: false });
  await rabbit('POST', `/bindings/%2F/e/food.events/q/${INSPECT}`, { routing_key: 'order.status_changed.v1' });

  execSync('node scripts/seed-delivery-agents.mjs', { stdio: 'ignore' });
  const all = await api('GET', '/restaurants?limit=50');
  restaurant = all.body.data.find((r) => r.isOpen);
  items = (await api('GET', `/restaurants/${restaurant.id}/menu`)).body.data.items.filter((i) => i.isAvailable);

  // ============================================================ N1
  console.log('\nN1 — order confirmation (payment confirmed via the order transition)');
  const a = await newCustomer('lifecycle');
  const oa = await placeOrder(a.token);
  await sleep(2000);
  check('no email for placement (pending_payment has no template)', (await inbox(a.email)).length === 0);
  const confirmed = await pay(a.token, oa);
  check('order confirmed by payment', confirmed?.status === 'confirmed', confirmed);
  const [conf] = (await waitInbox(a.email, 1)) ?? [];
  check('exactly one confirmation email captured by Mailpit', conf && /Payment received/.test(conf.Subject), conf);
  const confMsg = conf && (await message(conf.ID));
  check('confirmation email has text + HTML with order number, items and amount paid', confMsg?.Text.includes(oa.orderNumber) && confMsg.Text.includes(items[0].name) && /₹/.test(confMsg.Text) && /<html/i.test(confMsg.HTML), confMsg?.Text);
  const confHeaders = conf && (await headersOf(conf.ID));
  check('email tagged with template + order id headers', confHeaders?.['X-Template']?.[0] === 'ORDER_CONFIRMED' && confHeaders['X-Order-Id']?.[0] === oa.id, confHeaders);

  // ============================================================ N2
  console.log('\nN2 — delivery lifecycle emails (real Delivery Service and partner)');
  const partner = await assignedPartner(a.token, oa.id);
  const { verified } = await completeDelivery(a, oa, partner);
  check('partner picked up, arrived and verified the OTP from the email', verified);
  const delivered = await waitOrder(a.token, oa.id, (o) => o.status === 'delivered', 40_000);
  check('Order Service applied every step → delivered', !!delivered, await getOrder(a.token, oa.id));
  const mails = (await waitInbox(a.email, 7, 30_000)) ?? (await inbox(a.email));
  const subjects = mails.map((m) => m.Subject);
  check('7 emails: confirmed, assigning, partner assigned, out for delivery, arrived, delivery code, delivered', mails.length === 7, subjects);
  for (const [label, re] of [
    ['delivery assignment started', /Finding a delivery partner/],
    ['partner assigned (with partner name)', new RegExp(`${partner.name} will deliver`)],
    ['out for delivery', /out for delivery/],
    ['agent arrived', /has arrived/],
    ['delivery code (restricted workflow)', /delivery code/],
    ['delivered', /^Delivered/],
  ]) check(`  ${label}`, subjects.some((s) => re.test(s)), subjects);
  const out = mails.find((m) => /out for delivery/.test(m.Subject));
  check('out-for-delivery email names the partner (carried forward by the Order Service)', (await message(out?.ID))?.Text.includes(partner.name));
  const arrived = mails.find((m) => /has arrived/.test(m.Subject));
  check('arrival email contains no OTP (sent separately on the restricted channel)', !/\b\d{4,6}\b/.test((await message(arrived?.ID))?.Text.replace(oa.orderNumber, '') ?? '1234'));
  const tracking = await api('GET', `/orders/${oa.id}/tracking`, { token: a.token });
  check('tracking shows every step reached', tracking.body.data?.steps.every((s) => s.reached) && tracking.body.data.terminal, tracking.body.data?.steps);

  // ============================================================ N3
  console.log('\nN3 — duplicates produce no extra email');
  await drain();
  const confEvt = statusEvents.find((e) => e.data.orderId === oa.id && e.data.status === 'confirmed');
  await publish('order.status_changed.v1', confEvt); // redelivery (same eventId)
  await publish('order.status_changed.v1', { ...confEvt, eventId: randomUUID() }); // same transition, new id
  await publish('delivery.partner_assigned.v1', { ...deliveryEvent('delivery.partner_assigned', oa.id), data: { ...deliveryEvent('delivery.partner_assigned', oa.id).data, deliveryId: partner.deliveryId } }); // stale fact → ignored
  await sleep(5000);
  check('still 7 emails after duplicate events', (await inbox(a.email)).length === 7, (await inbox(a.email)).map((m) => m.Subject));
  check('one notification record per transition + one delivery code (7 records, all sent)', notificationRecord(a.email).filter((n) => n.status === 'sent').length === 7);

  // ============================================================ N4
  console.log('\nN4 — cancellation email; rejected transitions send nothing');
  const b = await newCustomer('cancel');
  const ob = await placeOrder(b.token);
  await sendDelivery('delivery.completed', ob.id); // illegal: unpaid order cannot be delivered
  const cancel = await api('POST', `/orders/${ob.id}/cancel`, { token: b.token, body: { reason: 'Ordered by mistake' } });
  check('cancel → 200', cancel.status === 200 && cancel.body.data.status === 'cancelled', cancel.body);
  const again = await api('POST', `/orders/${ob.id}/cancel`, { token: b.token, body: { reason: 'again' } });
  check('second cancel rejected → 409', again.status === 409);
  await sendDelivery('delivery.ready_for_pickup', ob.id); // cancelled order: ignored
  const [cmail] = (await waitInbox(b.email, 1)) ?? [];
  check('cancellation email with reason and "not charged"', cmail && /cancelled/.test(cmail.Subject) && (await message(cmail.ID)).Text.includes('Ordered by mistake') && (await message(cmail.ID)).Text.includes('not charged'), cmail);
  await sleep(5000);
  check('exactly one email (no delivered / no second cancellation / nothing for the ignored delivery event)', (await inbox(b.email)).length === 1, (await inbox(b.email)).map((m) => m.Subject));
  check('order history unaffected by rejected events', (await getOrder(b.token, ob.id)).statusHistory.map((x) => x.status).join() === 'pending_payment,cancelled');

  console.log('\nN5 — stale and conflicting delivery events');
  const c = await newCustomer('ooo');
  const oc = await placeOrder(c.token);
  await pay(c.token, oc);
  const cPartner = await assignedPartner(c.token, oc.id);
  await publish('delivery.ready_for_pickup.v1', { ...deliveryEvent('delivery.ready_for_pickup', oc.id), data: { ...deliveryEvent('delivery.ready_for_pickup', oc.id).data, deliveryId: cPartner.deliveryId } }); // stale
  await publish('delivery.picked_up.v1', deliveryEvent('delivery.picked_up', oc.id)); // forged: another delivery id
  await sleep(4000);
  const still = await getOrder(c.token, oc.id);
  check('stale and conflicting facts change nothing', still.status === 'partner_assigned' && still.statusHistory.length === 4, still.statusHistory.map((x) => x.status));
  await agentDo(cPartner, 'pickup');
  const ooo = await waitOrder(c.token, oc.id, (o) => o.status === 'out_for_delivery', 40_000);
  check('the real pickup moves the order on; steps in order', ooo?.statusHistory.map((x) => x.status).join() === 'pending_payment,confirmed,assigning_delivery_partner,partner_assigned,out_for_delivery', ooo?.statusHistory);
  const oooMails = (await waitInbox(c.email, 4, 20_000)) ?? [];
  check('4 emails, one per accepted transition', oooMails.length === 4, oooMails.map((m) => m.Subject));
  const cDone = await completeDelivery(c, oc, { ...cPartner });
  check('partner released by completing the delivery', cDone.verified);

  console.log('\nN6 — malformed event → notification DLQ, no email');
  const dlqBefore = await queueDepth('notification-service.order-events.dlq');
  const bad = { ...confEvt, eventId: randomUUID(), data: { ...confEvt.data, orderId: `bad${RUN}`, customerEmail: `malformed-${RUN}@example.com`, summary: undefined } };
  await publish('order.status_changed.v1', bad);
  const dlq = await waitFor(async () => (await queueDepth('notification-service.order-events.dlq')) > dlqBefore, 20_000);
  check('malformed event dead-lettered', !!dlq);
  check('no email for the malformed event', (await inbox(`malformed-${RUN}@example.com`)).length === 0);

  if (EXPIRY) {
    console.log('\nN7 — expiry email (order-service temporarily on a 12 s deadline)');
    compose('up -d order-service', { ORDER_PAYMENT_DEADLINE_SECONDS: '12', EXPIRY_SWEEP_INTERVAL_MS: '1000' });
    await waitFor(async () => (await api('GET', '/health/order')).status === 200, 90_000, 1000);
    try {
      const e = await newCustomer('expiry');
      const oe = await placeOrder(e.token);
      const exp = await waitOrder(e.token, oe.id, (o) => o.status === 'expired', 60_000);
      check('order expired', !!exp, exp);
      const [emsg] = (await waitInbox(e.email, 1)) ?? [];
      check('expiry email sent', emsg && /expired/.test(emsg.Subject), emsg);
    } finally {
      compose('up -d order-service');
      await waitFor(async () => (await api('GET', '/health/order')).status === 200, 90_000, 1000);
    }
  } else console.log('\nN7 — expiry: skipped (run with --expiry)');

  if (!RESILIENCE) {
    console.log('\nN8–N10 — resilience: skipped (run with --resilience)');
    return;
  }

  console.log('\nN8 — SMTP (Mailpit) outage: orders unaffected, email retried and delivered');
  const d = await newCustomer('smtp-down');
  const od = await placeOrder(d.token);
  compose('stop mailpit');
  const t0 = Date.now();
  const cd = await api('POST', `/orders/${od.id}/cancel`, { token: d.token, body: { reason: 'SMTP outage test' } });
  check('order cancelled immediately while SMTP is down', cd.status === 200 && Date.now() - t0 < 3000, cd.body);
  const retrying = await waitFor(async () => notificationRecord(d.email).find((n) => n.attempts >= 2 && n.status !== 'sent'), 30_000);
  check('send attempts fail and are retried (attempts + failure details persisted)', retrying?.failures?.length >= 1 && !!retrying.lastError, retrying);
  const hs = await waitFor(async () => notificationHealth()?.checks?.smtp === 'down' && notificationHealth(), 30_000);
  check('health reports smtp down → degraded (service keeps consuming events)', hs?.status === 'degraded' && hs.checks.mongo === 'up', hs);
  compose('start mailpit');
  await waitFor(async () => !!(await mailpit('/info')), 30_000);
  const dm = await waitInbox(d.email, 1, 120_000);
  check('after recovery the email is delivered exactly once', dm?.length === 1 && /cancelled/.test(dm[0].Subject), dm);
  check('record marked sent with the attempt history', notificationRecord(d.email)[0]?.status === 'sent');

  console.log('\nN9 — RabbitMQ outage: email delivered after recovery');
  const r = await newCustomer('broker-down');
  const or = await placeOrder(r.token);
  compose('stop rabbitmq');
  await sleep(3000);
  const cr = await api('POST', `/orders/${or.id}/cancel`, { token: r.token, body: { reason: 'Broker outage test' } });
  check('order cancelled while RabbitMQ is down (event kept in the outbox)', cr.status === 200, cr.body);
  await sleep(3000);
  check('no email yet', (await inbox(r.email)).length === 0);
  compose('start rabbitmq');
  const rm = await waitInbox(r.email, 1, 120_000);
  check('after recovery: exactly one cancellation email', rm?.length === 1, rm);

  console.log('\nN10 — notification-service restart: queued events processed once');
  const s = await newCustomer('restart');
  const os = await placeOrder(s.token);
  compose('stop notification-service');
  const cs = await api('POST', `/orders/${os.id}/cancel`, { token: s.token, body: { reason: 'Restart test' } });
  check('order cancelled while notification-service is down', cs.status === 200, cs.body);
  // Management API stats refresh every ~5 s, so poll.
  check('event waits in the durable queue', !!(await waitFor(async () => (await queueDepth('notification-service.order-events')) >= 1, 15_000)));
  compose('start notification-service');
  const sm = await waitInbox(s.email, 1, 90_000);
  await sleep(4000);
  check('after restart: exactly one email', sm?.length === 1 && (await inbox(s.email)).length === 1, sm);
  check('notification-service healthy again', (await waitFor(async () => notificationHealth()?.status === 'ok', 60_000)) === true);
}

try {
  await main();
} catch (err) {
  failed++;
  console.error('\nNotification E2E crashed:', err);
} finally {
  await rabbit('DELETE', `/queues/%2F/${INSPECT}`).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
