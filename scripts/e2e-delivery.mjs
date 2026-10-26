#!/usr/bin/env node
/**
 * Delivery Service end-to-end test against the running Docker Compose stack (Stage 6).
 *   node scripts/init-env.mjs && docker compose up -d --build && node scripts/e2e-delivery.mjs [--resilience]
 *
 * Runs the whole customer journey through the gateway — order, billing, mock payment, preparation,
 * random partner assignment, pickup, arrival, OTP email in Mailpit, OTP verification, delivered — and
 * checks history, emails, live tracking (SSE), OTP security, broker permissions, cancellation and
 * no-partner handling. --resilience adds RabbitMQ / Delivery / Notification / MongoDB outages.
 * The delivery-service is temporarily recreated with short delays and restored at the end.
 * Nothing bypasses OTP verification: the code is read from the customer's email in Mailpit.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { env } from './lib-env.mjs';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const RABBIT = process.env.RABBITMQ_API ?? 'http://localhost:15672';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const ADMIN_USER = env('RABBITMQ_USER', 'food');
const RABBIT_AUTH = 'Basic ' + Buffer.from(`${ADMIN_USER}:${env('RABBITMQ_PASSWORD', 'food-dev-password')}`).toString('base64');
const AGENT_PASSWORD = env('DELIVERY_AGENT_PASSWORD');
const RESILIENCE = process.argv.includes('--resilience');
const RUN = Date.now().toString(36);
const INSPECT = `e2e.delivery.${RUN}`;
// Short, configurable delays for the test run (production-like defaults are restored afterwards).
const FAST = {
  PREPARATION_DELAY_MS: '3000',
  ASSIGNMENT_DELAY_MS: '1000',
  ASSIGNMENT_RETRY_MS: '1000',
  ASSIGNMENT_MAX_ATTEMPTS: '4',
  OTP_TTL_MS: '25000',
  OTP_RESEND_COOLDOWN_MS: '3000',
};

let passed = 0;
let failed = 0;
function check(name, condition, info) {
  if (condition) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 600) : '');
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 30_000, everyMs = 500) {
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
      if (res.status === 429 && path.startsWith('/auth') && attempt < 10) {
        await sleep(500);
        continue;
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 200) };
      }
      return { status: res.status, body: parsed, headers: res.headers };
    } catch (err) {
      if (attempt >= 15) throw err;
      await sleep(1000);
    }
  }
}
async function rabbit(method, path, body) {
  const res = await fetch(`${RABBIT}/api${path}`, { method, headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const publishGeneral = (key, envelope) =>
  rabbit('POST', '/exchanges/%2F/food.events/publish', { routing_key: key, payload: JSON.stringify(envelope), payload_encoding: 'string', properties: { delivery_mode: 2 } });
const queueDepth = async (q) => (await rabbit('GET', `/queues/%2F/${encodeURIComponent(q)}`))?.messages ?? 0;

const events = [];
async function drain() {
  const got = await rabbit('POST', `/queues/%2F/${INSPECT}/get`, { count: 500, ackmode: 'ack_requeue_false', encoding: 'auto' });
  for (const m of got ?? []) events.push({ key: m.routing_key, body: JSON.parse(m.payload) });
}
const eventsFor = async (orderId) => {
  await drain();
  return events.filter((e) => e.body.data?.orderId === orderId);
};

async function mailpit(path) {
  const res = await fetch(`${MAILPIT}/api/v1${path}`);
  return res.ok ? res.json() : null;
}
const inbox = async (address) => ((await mailpit(`/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=100`))?.messages ?? []).reverse(); // oldest first
const messageText = async (id) => (await mailpit(`/message/${id}`))?.Text ?? '';

function compose(cmd, extraEnv = {}) {
  execSync(`docker compose ${cmd}`, { stdio: 'ignore', env: { ...process.env, ...extraEnv } });
}
const containerStart = (svc) => execSync(`docker start $(docker compose ps -a -q ${svc})`, { stdio: 'ignore' });
function mongoEval(db, js) {
  if (js.includes("'")) throw new Error('mongoEval scripts must not contain single quotes');
  const out = execSync(`docker compose exec -T mongo mongosh --quiet ${db} --eval '${js}'`, { encoding: 'utf8' });
  return out.trim().split('\n').at(-1);
}
const health = async (svc) => (await api('GET', `/health/${svc}`)).status === 200;

// ---------------------------------------------------------------- journey helpers

let restaurant;
let items;
let adminToken;
const address = { line1: '21, 100 Feet Road, Indiranagar', city: 'Bengaluru', pincode: '560038', landmark: 'Near the metro' };
const agentEmail = (name) => `agent.${name.toLowerCase().replaceAll(' ', '.')}@food.local`;

async function newCustomer(label) {
  const email = `deliv-${label}-${RUN}@example.com`;
  await api('POST', '/auth/register', { body: { name: `Customer ${label}`, email, password: 'Hungry123', phone: '9123456780' } });
  const login = await api('POST', '/auth/login', { body: { email, password: 'Hungry123' } });
  return { email, token: login.body.data.accessToken };
}
async function placeOrder(token) {
  const res = await waitFor(async () => {
    const r = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ menuItemId: items[0].id, quantity: 2 }, { menuItemId: items[1].id, quantity: 1 }], deliveryAddress: address } });
    return r.status === 503 ? null : r;
  }, 30_000);
  if (res?.status !== 201) throw new Error(`order failed: ${JSON.stringify(res?.body)}`);
  return res.body.data;
}
const getOrder = (token, id) => api('GET', `/orders/${id}`, { token }).then((r) => r.body.data);
const tracking = (token, id) => api('GET', `/orders/${id}/tracking`, { token }).then((r) => r.body.data);
const waitStatus = (token, id, status, t = 40_000) => waitFor(async () => ((await tracking(token, id))?.status === status ? tracking(token, id) : null), t);

async function pay(token, order) {
  let init;
  const ready = await waitFor(async () => {
    init = await api('POST', '/payments/initiate', { token, body: { orderId: order.id } });
    return init.body?.error?.code !== 'BILLING_PENDING';
  }, 30_000, 1000);
  if (!ready || init.status !== 201) throw new Error(`initiate failed: ${JSON.stringify(init?.body)}`);
  await api('POST', `/payments/${init.body.data.payment.id}/simulate`, { token, body: { outcome: 'succeed' } });
  return { invoiceAmount: init.body.data.payment.amount, confirmed: await waitStatus(token, order.id, 'confirmed', 30_000) };
}
const deliveryOf = async (orderId) => (await waitFor(async () => {
  const r = await api('GET', `/deliveries/order/${orderId}`, { token: adminToken });
  return r.status === 200 ? r.body.data : null;
}, 20_000));
async function agentFor(customerToken, orderId) {
  const t = await waitStatus(customerToken, orderId, 'partner_assigned');
  if (!t) return null;
  const login = await api('POST', '/auth/login', { body: { email: agentEmail(t.deliveryPartner.name), password: AGENT_PASSWORD } });
  return { name: t.deliveryPartner.name, token: login.body?.data?.accessToken, id: login.body?.data?.user?.id ?? null };
}
const agentCall = (agent, deliveryId, action, body) => api('POST', `/deliveries/${deliveryId}/${action}`, { token: agent.token, body });
async function otpEmail(customerEmail, n = 1) {
  const mails = await waitFor(async () => {
    const all = (await inbox(customerEmail)).filter((m) => /delivery code/i.test(m.Subject));
    return all.length >= n ? all : null;
  }, 45_000);
  if (!mails) return null;
  const text = await messageText(mails[n - 1].ID);
  return { code: /Your delivery code is: (\d{6})/.exec(text)?.[1], text, count: mails.length };
}
/** Order placed + paid + assigned + picked up + arrived. Returns everything a step needs. */
async function toArrival(label) {
  const c = await newCustomer(label);
  const o = await placeOrder(c.token);
  await pay(c.token, o);
  const d = await deliveryOf(o.id);
  const agent = await agentFor(c.token, o.id);
  await agentCall(agent, d.id, 'pickup');
  await agentCall(agent, d.id, 'arrived');
  await waitStatus(c.token, o.id, 'location_reached');
  return { c, o, d, agent };
}

/** SSE through the gateway: collect tracking messages until `until` or timeout. */
async function trackStream(token, orderId, until, timeoutMs = 90_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const msgs = [];
  try {
    const res = await fetch(`${GATEWAY}/orders/${orderId}/tracking/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
    if (res.status !== 200) return { status: res.status, msgs };
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.includes('event: tracking')) msgs.push(JSON.parse(/^data: (.*)$/m.exec(block)[1]));
      }
      if (until(msgs)) break;
    }
    ctrl.abort();
    return { status: res.status, msgs };
  } catch {
    return { status: 200, msgs };
  } finally {
    clearTimeout(timer);
  }
}

/** Expect an AMQP operation by `user` to be refused (403 ACCESS_REFUSED). */
async function refused(user, password, op) {
  const conn = await amqp.connect(`amqp://${user}:${encodeURIComponent(password)}@localhost:5672`);
  conn.on('error', () => undefined);
  try {
    const ch = await conn.createConfirmChannel();
    const closed = new Promise((resolve) => ch.on('error', (err) => resolve(String(err.message))));
    const result = await Promise.race([op(ch).then(() => 'allowed', (err) => String(err.message)), closed]);
    const msg = result === 'allowed' ? await Promise.race([closed, sleep(1500).then(() => 'allowed')]) : result;
    return /ACCESS_REFUSED|403/.test(msg);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

/**
 * Test hygiene: deliveries created by E2E customers and still holding a partner are finished for real —
 * picked-up ones by the partner with the code from the customer's email, unpicked ones cancelled by an admin.
 */
async function releaseE2eDeliveries() {
  const busy = (await api('GET', '/deliveries/agents?status=busy', { token: adminToken })).body.data ?? [];
  let completed = 0;
  let cancelled = 0;
  let failedN = 0;
  for (const a of busy) {
    const d = (await api('GET', `/deliveries/${a.activeDeliveryId}`, { token: adminToken })).body.data;
    if (!d || !/^(Customer|Notify|Pay|Billing|E2E) /.test(d.customerName ?? '')) continue;
    if (d.status === 'partner_assigned' || d.status === 'awaiting_partner') {
      const r = await api('POST', `/orders/${d.orderId}/cancel`, { token: adminToken, body: { reason: 'E2E cleanup: release delivery partner' } });
      r.status === 200 ? cancelled++ : failedN++;
      continue;
    }
    const agent = { token: (await api('POST', '/auth/login', { body: { email: a.email, password: AGENT_PASSWORD } })).body.data.accessToken };
    if (d.status === 'picked_up') await agentCall(agent, d.id, 'arrived');
    else await agentCall(agent, d.id, 'resend-otp'); // arrived earlier; its code may have expired
    const mail = await waitFor(async () => {
      const found = (await mailpit(`/search?query=${encodeURIComponent(`subject:"${d.orderNumber}"`)}&limit=20`))?.messages ?? [];
      return found.find((m) => /delivery code/i.test(m.Subject) && new Date(m.Created) > new Date(Date.now() - 60_000));
    }, 45_000);
    const code = /Your delivery code is: (\d{6})/.exec(mail ? await messageText(mail.ID) : '')?.[1];
    const v = code ? await agentCall(agent, d.id, 'verify-otp', { otp: code }) : { status: 0 };
    v.status === 200 ? completed++ : failedN++;
  }
  return { completed, cancelled, failed: failedN };
}

// ---------------------------------------------------------------- scenarios

async function main() {
  console.log(`Gateway ${GATEWAY} · Mailpit ${MAILPIT}`);
  if (!AGENT_PASSWORD) throw new Error('DELIVERY_AGENT_PASSWORD missing (node scripts/init-env.mjs)');

  console.log('\nSetup — fast delivery timings, partners, inspection queue');
  compose('up -d delivery-service', FAST);
  check('delivery-service healthy with test timings', !!(await waitFor(() => health('delivery'), 90_000, 1000)));
  execSync('node scripts/seed-delivery-agents.mjs', { stdio: 'ignore' });
  adminToken = (await api('POST', '/auth/login', { body: { email: env('ADMIN_EMAIL', 'admin@food.local'), password: env('ADMIN_PASSWORD') } })).body.data.accessToken;
  const agents = (await api('GET', '/deliveries/agents', { token: adminToken })).body.data;
  check('≥ 10 seeded delivery partners registered from their own JWTs', agents.length >= 10, agents.length);
  await rabbit('PUT', `/queues/%2F/${INSPECT}`, { durable: false, auto_delete: false });
  await rabbit('POST', `/bindings/%2F/e/food.events/q/${INSPECT}`, { routing_key: '#' });
  const dlqBefore = Object.fromEntries((await rabbit('GET', '/queues/%2F')).filter((q) => q.name.endsWith('.dlq')).map((q) => [q.name, q.messages ?? 0]));
  const all = await api('GET', '/restaurants?limit=50');
  restaurant = all.body.data.find((r) => r.isOpen);
  items = (await api('GET', `/restaurants/${restaurant.id}/menu`)).body.data.items.filter((i) => i.isAvailable);
  check('restaurant browsing works', !!restaurant && items.length >= 2);

  // ============================================================ D1
  console.log('\nD1 — full journey: order → payment → preparation → assignment → pickup → arrival → OTP → delivered');
  const c1 = await newCustomer('journey');
  check('1. customer registered and logged in', !!c1.token);
  const o1 = await placeOrder(c1.token);
  check('3. order placed (pending_payment)', o1.status === 'pending_payment');
  const live = trackStream(c1.token, o1.id, (m) => m.at(-1)?.status === 'delivered', 150_000);
  const { invoiceAmount, confirmed } = await pay(c1.token, o1);
  check('4–6. billing finalized, mock payment succeeded, order confirmed', !!confirmed && invoiceAmount > 0, confirmed);
  const d1 = await deliveryOf(o1.id);
  check('7. delivery created for the order (one record, preparing, address recorded)', d1?.orderId === o1.id && ['preparing', 'awaiting_partner', 'partner_assigned'].includes(d1.status) && d1.deliveryAddress?.city === 'Bengaluru', d1);
  const prep = await tracking(c1.token, o1.id);
  check('   tracking: delivery status shown while the restaurant prepares', ['preparing', 'awaiting_partner', 'partner_assigned'].includes(prep.deliveryStatus), prep.deliveryStatus);
  const t8 = await waitStatus(c1.token, o1.id, 'assigning_delivery_partner', 20_000) ?? (await tracking(c1.token, o1.id));
  check('8. preparation finished → ASSIGNING_DELIVERY_PARTNER (or already beyond)', ['assigning_delivery_partner', 'partner_assigned'].includes(t8.status), t8.status);
  const agent1 = await agentFor(c1.token, o1.id);
  const t9 = await tracking(c1.token, o1.id);
  check('9. partner assigned at random from the pool; tracking shows public details only', !!agent1 && t9.deliveryPartner?.name === agent1.name && /^\+?[\d ]*\d\dX+\d\d$/.test(t9.deliveryPartner.phoneMasked), t9.deliveryPartner);
  check('10. assigned partner authenticates with their own account', !!agent1?.token);
  const me = (await api('GET', '/deliveries/agents/me', { token: agent1.token })).body.data;
  check('    partner is reserved for exactly this delivery', me.status === 'busy' && me.activeDelivery?.id === d1.id && me.activeDelivery.customerName && !JSON.stringify(me.activeDelivery).includes(c1.email), me);

  // authorization
  const otherAgentName = agents.find((a) => a.name !== agent1.name && a.status !== 'busy')?.name ?? agents.find((a) => a.name !== agent1.name).name;
  const otherAgent = { token: (await api('POST', '/auth/login', { body: { email: agentEmail(otherAgentName), password: AGENT_PASSWORD } })).body.data.accessToken };
  check('    another partner cannot pick it up (404)', (await agentCall(otherAgent, d1.id, 'pickup')).status === 404);
  check('    the customer cannot act as a partner (403)', (await api('POST', `/deliveries/${d1.id}/pickup`, { token: c1.token })).status === 403);
  check('    anonymous call rejected (401)', (await api('POST', `/deliveries/${d1.id}/pickup`)).status === 401);
  check('    customers cannot read delivery records (403)', (await api('GET', `/deliveries/${d1.id}`, { token: c1.token })).status === 403);
  check('    arrival before pickup refused (409 DELIVERY_NOT_PICKED_UP)', (await agentCall(agent1, d1.id, 'arrived')).body?.error?.code === 'DELIVERY_NOT_PICKED_UP');
  check('    OTP verification before arrival refused (409 DELIVERY_NOT_ARRIVED)', (await agentCall(agent1, d1.id, 'verify-otp', { otp: '123456' })).body?.error?.code === 'DELIVERY_NOT_ARRIVED');

  const pick = await agentCall(agent1, d1.id, 'pickup');
  check('11. partner picks up (explicit, authenticated)', pick.status === 200 && pick.body.data.status === 'picked_up', pick.body);
  check('    duplicate pickup refused (409)', (await agentCall(agent1, d1.id, 'pickup')).body?.error?.code === 'DELIVERY_ALREADY_PICKED_UP');
  check('12. order is OUT_FOR_DELIVERY', !!(await waitStatus(c1.token, o1.id, 'out_for_delivery')));
  const arr = await agentCall(agent1, d1.id, 'arrived');
  check('13. partner arrives; OTP issued (state only, no code in the response)', arr.status === 200 && arr.body.data.otp?.status === 'active' && !/\b\d{6}\b/.test(JSON.stringify(arr.body.data.otp)), arr.body);
  check('    duplicate arrival refused (409)', (await agentCall(agent1, d1.id, 'arrived')).body?.error?.code === 'DELIVERY_ALREADY_ARRIVED');
  const t13 = await waitStatus(c1.token, o1.id, 'location_reached');
  check('    order is LOCATION_REACHED; tracking shows the code expiry, never the code', t13?.deliveryCodeExpiresAt && !JSON.stringify(t13).match(/otp"|verifier/i), t13);
  const otp1 = await otpEmail(c1.email);
  check('14. OTP email captured in Mailpit (dedicated template, 6-digit code)', /^\d{6}$/.test(otp1?.code ?? ''), otp1?.text);
  const wrong = otp1.code === '000000' ? '111111' : '000000';
  const bad = await agentCall(agent1, d1.id, 'verify-otp', { otp: wrong });
  check('    incorrect OTP rejected (422, 4 attempts left)', bad.status === 422 && bad.body.error.code === 'OTP_INVALID' && /4 attempt/.test(bad.body.error.message), bad.body);
  check('    OTP from the wrong partner rejected (404)', (await agentCall(otherAgent, d1.id, 'verify-otp', { otp: otp1.code })).status === 404);
  const ok = await agentCall(agent1, d1.id, 'verify-otp', { otp: otp1.code });
  check('15–16. partner submits the correct OTP → delivery DELIVERED', ok.status === 200 && ok.body.data.status === 'delivered' && ok.body.data.otp.status === 'consumed', ok.body);
  check('    OTP cannot be reused (409)', (await agentCall(agent1, d1.id, 'verify-otp', { otp: otp1.code })).body?.error?.code === 'ALREADY_DELIVERED');
  const done = await waitStatus(c1.token, o1.id, 'delivered');
  check('17. Order Service reflects DELIVERED (completed, terminal)', done?.completed === true && done.terminal && done.deliveryStatus === 'delivered', done);
  const expected = ['pending_payment', 'confirmed', 'assigning_delivery_partner', 'partner_assigned', 'out_for_delivery', 'location_reached', 'delivered'];
  const hist = done.history;
  check('18. chronological status history is exactly the lifecycle (last = current)', JSON.stringify(hist.map((h) => h.status)) === JSON.stringify(expected) && hist.every((h, i) => i === 0 || new Date(h.at) >= new Date(hist[i - 1].at)), hist.map((h) => h.status));
  check('    each history entry: source event id + service; partner public details on assignment', hist.every((h) => h.sourceEventId && h.sourceService) && hist[3].metadata.agentName === agent1.name && hist.slice(2).every((h) => h.sourceService === 'delivery-service'), hist);
  check('    partner released after completion', (await api('GET', '/deliveries/agents/me', { token: agent1.token })).body.data.status === 'available');
  const mails = await waitFor(async () => ((await inbox(c1.email)).length >= 7 ? inbox(c1.email) : null), 30_000) ?? (await inbox(c1.email));
  const subjects = mails.map((m) => m.Subject);
  check('19. Mailpit: confirmed, assigning, partner assigned, out for delivery, arrived, OTP, delivered (7)', mails.length === 7, subjects);
  for (const [label, re] of [['confirmation', /Payment received/], ['assigning', /Finding a delivery partner/], ['partner assigned', new RegExp(`${agent1.name} will deliver`)], ['out for delivery', /out for delivery/], ['arrived', /has arrived/], ['OTP', /delivery code/], ['delivered', /^Delivered/]]) {
    check(`    email: ${label}`, subjects.some((s) => re.test(s)), subjects);
  }
  const sse = await live;
  const seen = [...new Set(sse.msgs.map((m) => m.status))];
  check('    live tracking over SSE through the gateway followed the whole lifecycle', sse.status === 200 && seen[0] === 'pending_payment' && seen.at(-1) === 'delivered' && seen.length >= 5, seen);
  check('    SSE never carried OTP material', !sse.msgs.some((m) => JSON.stringify(m).includes(otp1.code) && /code"|otp/i.test(JSON.stringify(m))));

  // RabbitMQ verification for this order
  const evs = await eventsFor(o1.id);
  const keys = evs.map((e) => e.key);
  check('RabbitMQ: delivery milestones in order on food.events', ['delivery.ready_for_pickup.v1', 'delivery.partner_assigned.v1', 'delivery.picked_up.v1', 'delivery.location_reached.v1', 'delivery.completed.v1'].every((k, i, a) => keys.indexOf(k) >= 0 && (i === 0 || keys.indexOf(k) > keys.indexOf(a[i - 1]))), keys);
  check('RabbitMQ: every event has id, type, timestamp, source, aggregate id and correlation id', evs.every((e) => e.body.eventId && e.body.eventType && e.body.occurredAt && e.body.source && e.body.aggregateId === o1.id && e.body.correlationId), evs.find((e) => !e.body.aggregateId)?.body);
  check('RabbitMQ: 6 order.status_changed (one per accepted transition after placement) + placement', keys.filter((k) => k === 'order.status_changed.v1').length === 7, keys.filter((k) => k === 'order.status_changed.v1').length);
  check('RabbitMQ: the OTP command never appears on food.events (a "#" binding sees nothing)', !events.some((e) => e.key.startsWith('notification.')) && !events.some((e) => JSON.stringify(e.body).includes(`"${otp1.code}"`)));
  check('RabbitMQ: delivery.completed states otpVerified', evs.find((e) => e.key === 'delivery.completed.v1')?.body.data.otpVerified === true);

  // OTP never at rest or in logs
  const dbHits = ['delivery_db', 'order_db', 'notification_db'].filter((db) =>
    mongoEval(db, `let hit=false; db.getCollectionNames().forEach(c => { if (EJSON.stringify(db[c].find().toArray()).match(/(^|[^0-9A-Za-z-])${otp1.code}([^0-9A-Za-z-]|$)/)) hit = true }); print(hit)`) === 'true',
  );
  check('OTP not stored in plaintext in any service database', dbHits.length === 0, dbHits);
  const logs = execSync('docker compose logs --since 10m delivery-service order-service notification-service gateway 2>&1', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  check('OTP never written to any service or gateway log', !new RegExp(`(^|[^0-9A-Za-z-])${otp1.code}([^0-9A-Za-z-]|$)`, 'm').test(logs.replace(/"time":"[^"]+"/g, '')));

  // ============================================================ D2
  console.log('\nD2 — OTP security: attempts, lock, cooldown, expiry, reissue limit, concurrency');
  const s2 = await toArrival('otp');
  const first = await otpEmail(s2.c.email);
  const wrong2 = first.code === '000000' ? '111111' : '000000';
  const wrongs = await Promise.all(Array.from({ length: 8 }, () => agentCall(s2.agent, s2.d.id, 'verify-otp', { otp: wrong2 })));
  check('8 concurrent wrong codes: exactly 4 counted as "invalid", the rest locked (limit 5 never exceeded)', wrongs.filter((r) => r.status === 422).length === 4 && wrongs.every((r) => r.status === 422 || r.status === 423), wrongs.map((r) => r.status));
  check('locked code rejects even the correct value (423)', (await agentCall(s2.agent, s2.d.id, 'verify-otp', { otp: first.code })).status === 423);
  const soon = await agentCall(s2.agent, s2.d.id, 'resend-otp');
  check('reissue within the cooldown refused (429 OTP_RESEND_TOO_SOON)', soon.status === 429 && soon.body.error.code === 'OTP_RESEND_TOO_SOON', soon.body);
  await sleep(3200);
  check('reissue after the cooldown → new code by email', (await agentCall(s2.agent, s2.d.id, 'resend-otp')).status === 200);
  const second = await otpEmail(s2.c.email, 2);
  check('second OTP email delivered', /^\d{6}$/.test(second?.code ?? ''));
  console.log('  waiting for the second code to expire (25 s test TTL)…');
  await sleep(26_000);
  check('expired code refused (410 OTP_EXPIRED)', (await agentCall(s2.agent, s2.d.id, 'verify-otp', { otp: second.code })).body?.error?.code === 'OTP_EXPIRED');
  check('third (last allowed) reissue', (await agentCall(s2.agent, s2.d.id, 'resend-otp')).status === 200);
  await sleep(3200);
  check('reissue limit enforced (429 OTP_RESEND_LIMIT)', (await agentCall(s2.agent, s2.d.id, 'resend-otp')).body?.error?.code === 'OTP_RESEND_LIMIT');
  const third = await otpEmail(s2.c.email, 3);
  const racers = await Promise.all(Array.from({ length: 5 }, () => agentCall(s2.agent, s2.d.id, 'verify-otp', { otp: third.code })));
  check('5 concurrent correct submissions → delivered exactly once', racers.filter((r) => r.status === 200).length === 1, racers.map((r) => r.status));
  const ev2 = await waitFor(async () => ((await eventsFor(s2.o.id)).some((e) => e.key === 'delivery.completed.v1') ? eventsFor(s2.o.id) : null), 15_000);
  check('one delivery.completed for the order', ev2?.filter((e) => e.key === 'delivery.completed.v1').length === 1);
  check('order delivered', !!(await waitStatus(s2.c.token, s2.o.id, 'delivered')));

  // ============================================================ D3
  console.log('\nD3 — cancellation and duplicates');
  const c3 = await newCustomer('cancel-early');
  const o3 = await placeOrder(c3.token);
  await pay(c3.token, o3);
  const cancel3 = await api('POST', `/orders/${o3.id}/cancel`, { token: c3.token, body: { reason: 'Ordered the wrong thing' } });
  check('customer cancels a confirmed order while it is being prepared', cancel3.status === 200, cancel3.body);
  const d3 = await waitFor(async () => {
    const r = await api('GET', `/deliveries/order/${o3.id}`, { token: adminToken });
    return r.body?.data?.status === 'cancelled' ? r.body.data : null;
  }, 20_000);
  check('delivery cancelled (or never started) — no partner assigned', d3?.status === 'cancelled' && !d3.agent, d3);
  const o3done = await waitFor(async () => ((await getOrder(c3.token, o3.id)).paymentStatus === 'refunded' ? getOrder(c3.token, o3.id) : null), 30_000);
  check('refund via the existing Payment/Billing workflow', o3done?.status === 'cancelled', o3done?.paymentStatus);
  await sleep(4000);
  check('no delivery milestone after cancellation', !(await eventsFor(o3.id)).some((e) => /delivery\.(ready|partner|picked|location|completed)/.test(e.key)));

  const c4 = await newCustomer('cancel-assigned');
  const o4 = await placeOrder(c4.token);
  await pay(c4.token, o4);
  const d4 = await deliveryOf(o4.id);
  const agent4 = await agentFor(c4.token, o4.id);
  check('customer may no longer cancel once a partner is assigned (409)', (await api('POST', `/orders/${o4.id}/cancel`, { token: c4.token, body: { reason: 'too slow' } })).status === 409);
  check('platform admin cancels after assignment', (await api('POST', `/orders/${o4.id}/cancel`, { token: adminToken, body: { reason: 'Restaurant ran out of stock' } })).status === 200);
  const freed = await waitFor(async () => ((await api('GET', '/deliveries/agents/me', { token: agent4.token })).body.data.status === 'available' ? true : null), 20_000);
  check('assigned partner released', !!freed);
  check('pickup of the cancelled delivery refused (409 DELIVERY_CANCELLED)', (await agentCall(agent4, d4.id, 'pickup')).body?.error?.code === 'DELIVERY_CANCELLED');
  check('order stays cancelled; tracking shows the delivery cancelled', (await tracking(c4.token, o4.id)).status === 'cancelled' && (await waitFor(async () => (await tracking(c4.token, o4.id)).deliveryStatus === 'cancelled', 15_000)));

  const s5 = await newCustomer('cancel-picked');
  const o5 = await placeOrder(s5.token);
  await pay(s5.token, o5);
  const d5 = await deliveryOf(o5.id);
  const agent5 = await agentFor(s5.token, o5.id);
  await agentCall(agent5, d5.id, 'pickup');
  await waitStatus(s5.token, o5.id, 'out_for_delivery');
  check('nobody can cancel after pickup (409 ORDER_NOT_CANCELLABLE)', (await api('POST', `/orders/${o5.id}/cancel`, { token: adminToken, body: { reason: 'late' } })).body?.error?.code === 'ORDER_NOT_CANCELLABLE');

  // duplicates: replay captured events
  const ev1 = await eventsFor(o1.id);
  const replay = ['order.confirmed.v1', 'delivery.partner_assigned.v1', 'delivery.picked_up.v1', 'delivery.completed.v1'].map((k) => ev1.find((e) => e.key === k));
  for (const e of replay) await publishGeneral(e.key, e.body);
  await publishGeneral(replay[2].key, { ...replay[2].body, eventId: randomUUID() }); // same fact, new id
  await sleep(5000);
  const after = await tracking(c1.token, o1.id);
  check('replayed events: no duplicate history entries', after.history.length === 7, after.history.map((h) => h.status));
  check('replayed events: no extra emails', (await inbox(c1.email)).length === 7);
  check('replayed order.confirmed: still one delivery for the order', (await api('GET', `/deliveries?limit=50`, { token: adminToken })).body.data.filter((x) => x.orderId === o1.id).length === 1);
  await publishGeneral('delivery.ready_for_pickup.v1', { ...ev1.find((e) => e.key === 'delivery.ready_for_pickup.v1').body, eventId: randomUUID() });
  await sleep(2000);
  check('late/out-of-order delivery event cannot move a delivered order', (await tracking(c1.token, o1.id)).status === 'delivered');
  const cancelledLate = (await eventsFor(o4.id)).find((e) => e.key === 'delivery.partner_assigned.v1');
  if (cancelledLate) await publishGeneral(cancelledLate.key, { ...cancelledLate.body, eventId: randomUUID() });
  await publishGeneral('delivery.completed.v1', { eventId: randomUUID(), eventType: 'delivery.completed', version: 1, occurredAt: new Date().toISOString(), source: 'delivery-service', data: { deliveryId: d4.id, orderId: o4.id, agentId: agent4.id ?? 'x', deliveredAt: new Date().toISOString(), otpVerified: true } });
  await sleep(4000);
  check('late events cannot resurrect a cancelled order', (await tracking(c4.token, o4.id)).status === 'cancelled');

  // ============================================================ D4
  console.log('\nD4 — no partner available: bounded retries, explicit failure, operator retry (no automatic refund)');
  execSync('node scripts/seed-delivery-agents.mjs --offline', { stdio: 'ignore' });
  const c6 = await newCustomer('no-partner');
  const o6 = await placeOrder(c6.token);
  await pay(c6.token, o6);
  const failedT = await waitFor(async () => ((await tracking(c6.token, o6.id)).deliveryStatus === 'assignment_failed' ? tracking(c6.token, o6.id) : null), 40_000);
  check('assignment fails after the configured attempts (delivery.assignment_failed)', !!failedT && failedT.status === 'assigning_delivery_partner' && /No delivery partner/.test(failedT.deliveryIssue), failedT);
  check('no automatic refund for a delivery problem', (await getOrder(c6.token, o6.id)).paymentStatus === 'paid');
  execSync('node scripts/seed-delivery-agents.mjs', { stdio: 'ignore' });
  const d6 = (await api('GET', `/deliveries/order/${o6.id}`, { token: adminToken })).body.data;
  check('operator re-queues the assignment', (await api('POST', `/deliveries/${d6.id}/retry-assignment`, { token: adminToken })).status === 200);
  check('partner assigned after the retry', !!(await waitStatus(c6.token, o6.id, 'partner_assigned')));

  // ============================================================ broker permissions
  console.log('\nBroker isolation — per-service users and least-privilege permissions');
  const pw = (svc) => env(`RABBITMQ_${svc.toUpperCase()}_PASSWORD`);
  check('order-service cannot bind a queue to food.restricted', await refused('order-service', pw('order'), async (ch) => {
    await ch.assertQueue('order-service.sneaky', { durable: false, autoDelete: true });
    await ch.bindQueue('order-service.sneaky', 'food.restricted', 'notification.delivery_otp.v1');
  }));
  check('order-service cannot consume the OTP queue', await refused('order-service', pw('order'), (ch) => ch.consume('notification-service.delivery-otp', () => undefined)));
  check('delivery-service (the publisher) cannot read the OTP queue', await refused('delivery-service', pw('delivery'), (ch) => ch.consume('notification-service.delivery-otp', () => undefined)));
  check('payment-service cannot publish OTP commands', await refused('payment-service', pw('payment'), async (ch) => {
    ch.publish('food.restricted', 'notification.delivery_otp.v1', Buffer.from('{}'));
    await ch.waitForConfirms();
  }));
  check('notification-service cannot publish OTP commands', await refused('notification-service', pw('notification'), async (ch) => {
    ch.publish('food.restricted', 'notification.delivery_otp.v1', Buffer.from('{}'));
    await ch.waitForConfirms();
  }));
  check('no service may write to the default exchange (no queue injection)', await refused('payment-service', pw('payment'), async (ch) => {
    ch.sendToQueue('notification-service.delivery-otp', Buffer.from('{}'));
    await ch.waitForConfirms();
  }));
  check('payment-service cannot forge delivery events (topic permission)', await refused('payment-service', pw('payment'), async (ch) => {
    ch.publish('food.events', 'delivery.completed.v1', Buffer.from('{}'));
    await ch.waitForConfirms();
  }));
  check('the gateway exposes no notification or broker route', (await api('GET', '/health/notification')).status === 404 && (await api('GET', '/notifications')).status === 404);

  // ============================================================ resilience
  if (RESILIENCE) {
    console.log('\nR1 — RabbitMQ outage mid-delivery (pickup commits; Order catches up via the outbox)');
    const r1c = await newCustomer('mq-down');
    const r1o = await placeOrder(r1c.token);
    await pay(r1c.token, r1o);
    const r1d = await deliveryOf(r1o.id);
    const r1a = await agentFor(r1c.token, r1o.id);
    compose('stop rabbitmq');
    await sleep(3000);
    check('pickup accepted while RabbitMQ is down', (await agentCall(r1a, r1d.id, 'pickup')).status === 200);
    await sleep(2000);
    check('order not yet updated (event waits in the delivery outbox)', (await tracking(r1c.token, r1o.id)).status === 'partner_assigned');
    compose('start rabbitmq');
    check('after recovery → OUT_FOR_DELIVERY', !!(await waitStatus(r1c.token, r1o.id, 'out_for_delivery', 120_000)));

    console.log('\nR2 — Notification Service outage at arrival (OTP email delivered after recovery)');
    compose('stop notification-service');
    await agentCall(r1a, r1d.id, 'arrived');
    await sleep(3000);
    check('no OTP email while notification-service is down', (await inbox(r1c.email)).filter((m) => /delivery code/i.test(m.Subject)).length === 0);
    check('the OTP command waits in its durable restricted queue', !!(await waitFor(async () => (await queueDepth('notification-service.delivery-otp')) >= 1, 15_000)));
    containerStart('notification-service');
    const r2 = await otpEmail(r1c.email);
    check('after restart the OTP email arrives', /^\d{6}$/.test(r2?.code ?? ''));
    check('verification completes the delivery', (await agentCall(r1a, r1d.id, 'verify-otp', { otp: r2.code })).status === 200 && !!(await waitStatus(r1c.token, r1o.id, 'delivered')));

    console.log('\nR3 — Delivery Service restart during preparation (persisted deadlines)');
    const r3c = await newCustomer('restart');
    const r3o = await placeOrder(r3c.token);
    await pay(r3c.token, r3o);
    compose('stop delivery-service');
    await sleep(5000);
    containerStart('delivery-service');
    check('after restart the pending preparation resumes → partner assigned', !!(await waitStatus(r3c.token, r3o.id, 'partner_assigned', 90_000)));

    console.log('\nR4 — MongoDB outage');
    compose('stop mongo');
    const down = await waitFor(async () => !(await health('delivery')), 30_000, 1000);
    check('delivery-service reports unhealthy without its database', !!down);
    compose('start mongo');
    check('delivery-service recovers', !!(await waitFor(() => health('delivery'), 120_000, 2000)));
    check('order-service recovers', !!(await waitFor(() => health('order'), 120_000, 2000)));
    const r4a = await agentFor(r3c.token, r3o.id);
    const r3d = (await api('GET', `/deliveries/order/${r3o.id}`, { token: adminToken })).body.data;
    check('data persisted through the outage (delivery continues)', (await agentCall(r4a, r3d.id, 'pickup')).status === 200 && !!(await waitStatus(r3c.token, r3o.id, 'out_for_delivery', 60_000)));
  } else {
    console.log('\nR1–R4 — resilience: skipped (run with --resilience)');
  }

  // ============================================================ final consistency
  console.log('\nCleanup — finish or cancel deliveries left open by E2E runs (frees the shared partner pool)');
  const swept = await releaseE2eDeliveries();
  check('every E2E delivery completed (via the emailed OTP) or cancelled; partners released', swept.failed === 0, swept);

  console.log('\nFinal checks');
  await sleep(3000);
  const dlqAfter = (await rabbit('GET', '/queues/%2F')).filter((q) => q.name.endsWith('.dlq'));
  const grown = dlqAfter.filter((q) => (q.messages ?? 0) > (dlqBefore[q.name] ?? 0)).map((q) => `${q.name}=${q.messages}`);
  check('no new dead-lettered messages in any queue', grown.length === 0, grown);
  const pending = ['delivery_db', 'order_db', 'payment_db', 'billing_db', 'notification_db'].map((db) => [db, Number(mongoEval(db, 'print(db.outbox_events.countDocuments({status:"pending"}))'))]);
  check('all outboxes drained', pending.every(([, n]) => n === 0), pending);
  const busy = Number(mongoEval('delivery_db', 'print(db.delivery_agents.countDocuments({status:"busy", activeDeliveryId: {$exists: false}}))'));
  const doubled = mongoEval('delivery_db', 'print(db.delivery_agents.aggregate([{$match:{activeDeliveryId:{$exists:true}}},{$group:{_id:"$activeDeliveryId",n:{$sum:1}}},{$match:{n:{$gt:1}}}]).toArray().length)');
  check('no partner double-booked; no busy partner without a delivery', busy === 0 && doubled === '0', { busy, doubled });
  const dupDeliveries = mongoEval('delivery_db', 'print(db.deliveries.aggregate([{$group:{_id:"$orderId",n:{$sum:1}}},{$match:{n:{$gt:1}}}]).toArray().length)');
  check('exactly one delivery per order', dupDeliveries === '0');
}

try {
  await main();
} catch (err) {
  failed++;
  console.error('\nDelivery E2E crashed:', err);
} finally {
  await rabbit('DELETE', `/queues/%2F/${INSPECT}`).catch(() => undefined);
  try {
    compose('up -d delivery-service'); // restore default timings
  } catch {
    /* reported by health */
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
