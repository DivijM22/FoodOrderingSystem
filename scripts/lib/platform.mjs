// Shared helpers for scripts that drive the running Docker Compose stack through its public APIs
// (gateway, Mailpit, RabbitMQ management). Used by scripts/scenarios.mjs.
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { env } from '../lib-env.mjs';

export const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const RABBIT = process.env.RABBITMQ_API ?? 'http://localhost:15672';
const RABBIT_AUTH = 'Basic ' + Buffer.from(`${env('RABBITMQ_USER', 'food')}:${env('RABBITMQ_PASSWORD', 'food-dev-password')}`).toString('base64');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, timeoutMs = 30_000, everyMs = 500) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(everyMs);
  }
}

export async function api(method, path, { body, token } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${GATEWAY}${path}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && attempt < 10) {
        await sleep(500); // gateway rate limit on /auth
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
      if (attempt >= 15) throw err; // gateway restarting
      await sleep(1000);
    }
  }
}

export async function rabbit(method, path, body) {
  const res = await fetch(`${RABBIT}/api${path}`, { method, headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
export const publish = (key, envelope) =>
  rabbit('POST', '/exchanges/%2F/food.events/publish', { routing_key: key, payload: JSON.stringify(envelope), payload_encoding: 'string', properties: { delivery_mode: 2 } });

/** Collects every general event (food.events) during a run, for per-order event timelines. */
export class EventRecorder {
  constructor() {
    this.queue = `e2e.scenarios.${Date.now().toString(36)}`;
    this.events = [];
  }
  async start() {
    // Durable (with a TTL) so it survives the broker restarts some scenarios cause.
    await rabbit('PUT', `/queues/%2F/${this.queue}`, { durable: true, auto_delete: false, arguments: { 'x-message-ttl': 3_600_000 } });
    await rabbit('POST', `/bindings/%2F/e/food.events/q/${this.queue}`, { routing_key: '#' });
  }
  async drain() {
    const got = (await rabbit('POST', `/queues/%2F/${this.queue}/get`, { count: 500, ackmode: 'ack_requeue_false', encoding: 'auto' }).catch(() => [])) ?? [];
    if (got?.error === 'Object Not Found' || got?.error === 'not_found') await this.start().catch(() => undefined);
    for (const m of Array.isArray(got) ? got : []) this.events.push({ key: m.routing_key, body: JSON.parse(m.payload) });
  }
  async forOrder(orderId) {
    await this.drain();
    return this.events.filter((e) => e.body.data?.orderId === orderId);
  }
  async stop() {
    await rabbit('DELETE', `/queues/%2F/${this.queue}`).catch(() => undefined);
  }
}

export async function mailpit(path) {
  const res = await fetch(`${MAILPIT}/api/v1${path}`);
  return res.ok ? res.json() : null;
}
/** Messages for one recipient, oldest first. */
export const inbox = async (address) => ((await mailpit(`/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=100`))?.messages ?? []).reverse();
export const messageText = async (id) => (await mailpit(`/message/${id}`))?.Text ?? '';

export function compose(cmd, extraEnv = {}) {
  execSync(`docker compose ${cmd}`, { stdio: 'ignore', env: { ...process.env, ...extraEnv } });
}
/** Start one container without (re)starting its dependencies (unlike `docker compose start`). */
export const startOnly = (svc) => execSync(`docker start $(docker compose ps -a -q ${svc})`, { stdio: 'ignore' });
export const health = async (svc) => (await api('GET', `/health/${svc}`)).status === 200;

// ------------------------------------------------------------------ journey helpers (real client calls)

export const DEMO_AGENTS = ['Ravi Kumar', 'Ananya Iyer', 'Mohammed Faiz', 'Priya Nair', 'Arjun Reddy', 'Sneha Kulkarni', 'Vikram Singh', 'Lakshmi Menon', 'Rahul Das', 'Kavya Shetty', 'Imran Sheikh', 'Divya Pillai'];
export const agentEmail = (name) => `agent.${name.toLowerCase().replaceAll(' ', '.')}@food.local`;
export const agentPassword = () => env('DELIVERY_AGENT_PASSWORD');

export async function newCustomer(label) {
  const email = `scn-${label}-${Date.now().toString(36)}@example.com`;
  await api('POST', '/auth/register', { body: { name: `Scenario ${label}`, email, password: 'Hungry123', phone: '9123456780' } });
  const login = await api('POST', '/auth/login', { body: { email, password: 'Hungry123' } });
  return { email, token: login.body.data.accessToken };
}

let menuCache;
export async function menu() {
  if (menuCache) return menuCache;
  const all = await api('GET', '/restaurants?limit=50&isOpen=true');
  const restaurant = all.body.data[0];
  const items = (await api('GET', `/restaurants/${restaurant.id}/menu`)).body.data.items.filter((i) => i.isAvailable);
  return (menuCache = { restaurant, items });
}

export async function placeOrder(token, extra = {}) {
  const { restaurant, items } = await menu();
  const res = await waitFor(async () => {
    const r = await api('POST', '/orders', { token, body: { restaurantId: restaurant.id, items: [{ menuItemId: items[0].id, quantity: 2 }, { menuItemId: items[1].id, quantity: 1 }], deliveryAddress: { line1: '21, 100 Feet Road', city: 'Bengaluru', pincode: '560038' }, ...extra } });
    return r.status === 503 ? null : r; // catalog read model still syncing
  }, 30_000);
  if (res?.status !== 201) throw new Error(`order failed: ${JSON.stringify(res?.body)}`);
  return res.body.data;
}

export const tracking = (token, id) => api('GET', `/orders/${id}/tracking`, { token }).then((r) => r.body?.data);
export const waitStatus = (token, id, status, t = 45_000) => waitFor(async () => ((await tracking(token, id))?.status === status ? tracking(token, id) : null), t);

/** Starts the payment like a client (retrying 409 BILLING_PENDING). Returns the initiation payload. */
export async function initiate(token, orderId) {
  let r;
  await waitFor(async () => {
    r = await api('POST', '/payments/initiate', { token, body: { orderId } });
    return r.body?.error?.code !== 'BILLING_PENDING';
  }, 30_000, 1000);
  return r;
}
export const simulate = (token, paymentId, outcome) => api('POST', `/payments/${paymentId}/simulate`, { token, body: { outcome } });

export async function pay(token, orderId) {
  const init = await initiate(token, orderId);
  if (init.status !== 201 && init.status !== 200) throw new Error(`initiate failed: ${JSON.stringify(init.body)}`);
  await simulate(token, init.body.data.payment.id, 'succeed');
  return { init, confirmed: await waitStatus(token, orderId, 'confirmed', 30_000) };
}

/** Waits for the real assignment and signs in as the assigned partner (real Auth Service login). */
export async function assignedPartner(token, orderId) {
  const t = await waitStatus(token, orderId, 'partner_assigned', 60_000);
  if (!t) return null;
  const login = await api('POST', '/auth/login', { body: { email: agentEmail(t.deliveryPartner.name), password: agentPassword() } });
  const agentToken = login.body?.data?.accessToken;
  const me = (await api('GET', '/deliveries/agents/me', { token: agentToken })).body?.data;
  return { name: t.deliveryPartner.name, token: agentToken, deliveryId: me?.activeDelivery?.id };
}
export const agentDo = (agent, action, body) => api('POST', `/deliveries/${agent.deliveryId}/${action}`, { token: agent.token, body });

/** Reads the delivery code from the customer's email, as the customer would. */
export async function otpFromEmail(customerEmail, n = 1) {
  const mail = await waitFor(async () => {
    const all = (await inbox(customerEmail)).filter((m) => /delivery code/i.test(m.Subject));
    return all.length >= n ? all[n - 1] : null;
  }, 45_000);
  return mail ? /Your delivery code is: (\d{6})/.exec(await messageText(mail.ID))?.[1] : null;
}

/** pickup → arrived → OTP from Mailpit → verify (no shortcuts). */
export async function completeDelivery(customer, orderId, agent) {
  await agentDo(agent, 'pickup');
  await agentDo(agent, 'arrived');
  const code = await otpFromEmail(customer.email);
  const v = await agentDo(agent, 'verify-otp', { otp: code });
  return { code, verified: v.status === 200, delivered: !!(await waitStatus(customer.token, orderId, 'delivered')) };
}

export const newEventId = () => randomUUID();
