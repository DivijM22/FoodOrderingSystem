#!/usr/bin/env node
/**
 * Presentation-friendly scenario runner against the running stack (real client APIs only).
 *   node scripts/scenarios.mjs list
 *   node scripts/scenarios.mjs all
 *   node scripts/scenarios.mjs success cancel-refund agent-auth      (names or numbers 1–8)
 *
 * Each scenario prints its steps, passed/failed checks, the order id, the final order state, the events
 * observed on RabbitMQ for that order and any errors, and the run is saved to reports/scenarios/latest.{md,json}.
 * The exhaustive regression suites remain scripts/e2e-*.mjs; this runner tells one story per scenario.
 * Delivery timings are shortened for the run (delivery-service recreated, restored afterwards).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  agentDo, agentEmail, agentPassword, api, assignedPartner, completeDelivery, compose, DEMO_AGENTS, EventRecorder, health, inbox,
  initiate, newCustomer, newEventId, otpFromEmail, pay, placeOrder, publish, rabbit, simulate, sleep, startOnly, tracking, waitFor, waitStatus,
} from './lib/platform.mjs';
import { execSync } from 'node:child_process';

const FAST_DELIVERY = { PREPARATION_DELAY_MS: '3000', ASSIGNMENT_DELAY_MS: '1000', ASSIGNMENT_RETRY_MS: '1000' };
const recorder = new EventRecorder();

class Run {
  constructor(id, title) {
    Object.assign(this, { id, title, steps: [], checks: [], errors: [], orderId: null, finalState: null, events: [], startedAt: Date.now() });
  }
  step(text) {
    this.steps.push(text);
    console.log(`  · ${text}`);
  }
  check(name, ok, info) {
    this.checks.push({ name, ok: !!ok, ...(ok ? {} : { info: info === undefined ? undefined : JSON.stringify(info).slice(0, 300) }) });
    console.log(`    ${ok ? '✔' : '✘'} ${name}${ok || info === undefined ? '' : `  ${JSON.stringify(info).slice(0, 200)}`}`);
  }
  async finish(token) {
    if (this.orderId) {
      const t = token ? await tracking(token, this.orderId).catch(() => null) : null;
      if (t) this.finalState = { status: t.status, paymentStatus: t.paymentStatus, deliveryStatus: t.deliveryStatus, history: t.history.map((h) => h.status) };
      this.events = (await recorder.forOrder(this.orderId)).map((e) => ({ key: e.key, eventId: e.body.eventId, source: e.body.source, correlationId: e.body.correlationId ?? null }));
    }
    this.durationS = Math.round((Date.now() - this.startedAt) / 1000);
  }
  get passed() {
    return !this.errors.length && this.checks.every((c) => c.ok);
  }
}

// ================================================================== scenarios

const SCENARIOS = {
  async success(r) {
    const c = await newCustomer('success');
    r.step('customer registered and logged in');
    const o = await placeOrder(c.token);
    r.orderId = o.id;
    r.step(`order ${o.orderNumber} placed (pending_payment)`);
    const { init, confirmed } = await pay(c.token, o.id);
    r.check(`payment charged the finalized invoice amount (₹${(init.body.data.payment.amount / 100).toFixed(2)})`, init.body.data.payment.invoiceId);
    r.check('order confirmed by the verified payment', confirmed);
    const agent = await assignedPartner(c.token, o.id);
    r.step(`restaurant prepared; ${agent?.name} assigned at random`);
    r.check('partner assigned and signed in with their own account', agent?.token && agent.deliveryId);
    const done = await completeDelivery(c, o.id, agent);
    r.step('partner picked up, arrived; customer received the code by email; partner submitted it');
    r.check('OTP verified by the Delivery Service', done.verified);
    r.check('order DELIVERED', done.delivered);
    const t = await tracking(c.token, o.id);
    r.check('history = full lifecycle', t.history.map((h) => h.status).join(' → ') === 'pending_payment → confirmed → assigning_delivery_partner → partner_assigned → out_for_delivery → location_reached → delivered', t.history.map((h) => h.status));
    const mails = await waitFor(async () => ((await inbox(c.email)).length >= 7 ? inbox(c.email) : null), 20_000);
    r.check('7 customer emails incl. the delivery code (Mailpit)', mails?.length === 7, (await inbox(c.email)).map((m) => m.Subject));
    return c.token;
  },

  async 'payment-retry'(r) {
    const c = await newCustomer('retry');
    const o = await placeOrder(c.token);
    r.orderId = o.id;
    r.step(`order ${o.orderNumber} placed`);
    const first = await initiate(c.token, o.id);
    r.step('payment started');
    await simulate(c.token, first.body.data.payment.id, 'fail');
    r.step('card declined (mock provider, signed webhook)');
    const failed = await waitFor(async () => ((await api('GET', `/orders/${o.id}`, { token: c.token })).body.data.paymentStatus === 'failed' ? true : null), 20_000);
    r.check('order stays pending_payment with paymentStatus=failed (still payable)', failed && (await tracking(c.token, o.id)).status === 'pending_payment');
    const ev = await recorder.forOrder(o.id);
    r.check('payment.failed.v1 published (retryable)', ev.some((e) => e.key === 'payment.failed.v1' && e.body.data.retryable === true));
    const again = await initiate(c.token, o.id);
    r.check('retry reuses the same PaymentIntent', again.body.data.paymentIntentId === first.body.data.paymentIntentId);
    await simulate(c.token, again.body.data.payment.id, 'succeed');
    r.step('second attempt succeeds');
    r.check('order confirmed after the retry', await waitStatus(c.token, o.id, 'confirmed', 20_000));
    await api('POST', `/orders/${o.id}/cancel`, { token: c.token, body: { reason: 'Scenario cleanup' } });
    await waitFor(async () => ((await api('GET', `/orders/${o.id}`, { token: c.token })).body.data.paymentStatus === 'refunded' ? true : null), 30_000);
    r.step('cleanup: customer cancelled the confirmed order (refunded; frees the delivery partner)');
    return c.token;
  },

  async expiry(r) {
    r.step('order-service temporarily recreated with a 12 s payment deadline');
    compose('up -d order-service', { ORDER_PAYMENT_DEADLINE_SECONDS: '12', EXPIRY_SWEEP_INTERVAL_MS: '1000' });
    await waitFor(() => health('order'), 90_000, 1000);
    try {
      const c = await newCustomer('expiry');
      const o = await placeOrder(c.token);
      r.orderId = o.id;
      r.step(`order ${o.orderNumber} placed and left unpaid`);
      r.check('order expired by the worker', await waitStatus(c.token, o.id, 'expired', 60_000));
      const late = await initiate(c.token, o.id);
      r.check('late payment refused (409 ORDER_EXPIRED)', late.body?.error?.code === 'ORDER_EXPIRED', late.body);
      r.check('order.expired.v1 published', (await waitFor(async () => (await recorder.forOrder(o.id)).some((e) => e.key === 'order.expired.v1'), 15_000)));
      r.check('expiry email sent (Mailpit)', await waitFor(async () => (await inbox(c.email)).some((m) => /expired/i.test(m.Subject)), 30_000));
      r.check('order kept (never deleted)', (await api('GET', `/orders/${o.id}`, { token: c.token })).status === 200);
      return c.token;
    } finally {
      compose('up -d order-service');
      await waitFor(() => health('order'), 90_000, 1000);
      r.step('order-service restored to the 15-minute default');
    }
  },

  async 'cancel-refund'(r) {
    const c = await newCustomer('cancel');
    const o = await placeOrder(c.token, { discountCode: 'WELCOME50' });
    r.orderId = o.id;
    r.step(`order ${o.orderNumber} placed with WELCOME50`);
    const { init } = await pay(c.token, o.id);
    r.step(`paid ₹${(init.body.data.payment.amount / 100).toFixed(2)} (invoice amount after discount)`);
    const cancel = await api('POST', `/orders/${o.id}/cancel`, { token: c.token, body: { reason: 'Changed my mind' } });
    r.check('customer may cancel a confirmed order', cancel.status === 200 && cancel.body.data.paymentStatus === 'refund_pending', cancel.body);
    const refunded = await waitFor(async () => ((await api('GET', `/orders/${o.id}`, { token: c.token })).body.data.paymentStatus === 'refunded' ? true : null), 30_000);
    r.check('refund completed by the Payment Service → order paymentStatus refunded', refunded);
    const inv = (await api('GET', `/invoices/order/${o.id}`, { token: c.token })).body.data;
    r.check('invoice unchanged; refund recorded as a credit note (CN-…)', inv.status === 'refunded' && inv.adjustments.some((a) => a.kind === 'refund' && /^CN-/.test(a.documentNumber)), inv.adjustments);
    r.check('cancellation email sent', await waitFor(async () => (await inbox(c.email)).some((m) => /cancelled/i.test(m.Subject)), 20_000));
    r.check('no delivery milestone after the cancellation', !(await recorder.forOrder(o.id)).some((e) => /^delivery\.(ready|partner|picked)/.test(e.key)));
    const late = await api('POST', `/orders/${o.id}/cancel`, { token: c.token, body: { reason: 'again' } });
    r.check('second cancellation refused (409)', late.status === 409);
    return c.token;
  },

  async duplicates(r) {
    const c = await newCustomer('dupes');
    const o = await placeOrder(c.token);
    r.orderId = o.id;
    await pay(c.token, o.id);
    const agent = await assignedPartner(c.token, o.id);
    r.step(`order ${o.orderNumber} paid and assigned to ${agent.name}`);
    const before = await tracking(c.token, o.id);
    const mailsBefore = (await inbox(c.email)).length;
    const ev = await recorder.forOrder(o.id);
    const pick = (k) => ev.find((e) => e.key === k);
    const replay = ['order.created.v1', 'billing.finalized.v1', 'payment.succeeded.v1', 'order.confirmed.v1', 'delivery.ready_for_pickup.v1', 'delivery.partner_assigned.v1'].map(pick).filter(Boolean);
    for (const e of replay) await publish(e.key, e.body);
    for (const e of replay) await publish(e.key, { ...e.body, eventId: newEventId() });
    r.step(`replayed ${replay.length} captured events twice (same ids, then new ids): ${replay.map((e) => e.key).join(', ')}`);
    await sleep(6000);
    const after = await tracking(c.token, o.id);
    r.check('no duplicate history entries', after.history.length === before.history.length, after.history.map((h) => h.status));
    r.check('no duplicate emails', (await inbox(c.email)).length === mailsBefore);
    const pays = (await api('GET', `/payments?orderId=${o.id}`, { token: c.token })).body;
    r.check('exactly one payment', pays.meta.total === 1);
    const invs = (await api('GET', `/invoices?orderId=${o.id}`, { token: c.token })).body;
    r.check('exactly one invoice', invs.meta.total === 1);
    const ledger = (await api('GET', `/invoices/order/${o.id}`, { token: c.token })).body.data.adjustments.filter((a) => a.kind === 'payment');
    r.check('one payment entry in the billing ledger', ledger.length === 1);
    const done = await completeDelivery(c, o.id, agent);
    r.check('the delivery still completes normally', done.delivered);
    return c.token;
  },

  async 'rabbitmq-outage'(r) {
    const c = await newCustomer('mq');
    const o = await placeOrder(c.token);
    r.orderId = o.id;
    await pay(c.token, o.id);
    const agent = await assignedPartner(c.token, o.id);
    r.step(`order ${o.orderNumber} paid and assigned to ${agent.name}`);
    compose('stop rabbitmq');
    r.step('RabbitMQ stopped');
    await sleep(3000);
    r.check('services stay up (degraded, not down)', (await api('GET', '/health/order')).body?.status === 'degraded');
    r.check('partner pickup accepted during the outage (stored in the Delivery outbox)', (await agentDo(agent, 'pickup')).status === 200);
    const blocked = await api('POST', '/orders', { token: c.token, body: { restaurantId: o.restaurantId, items: [{ menuItemId: o.items[0].menuItemId, quantity: 1 }], deliveryAddress: o.deliveryAddress } });
    r.check('new orders refused rather than priced from a possibly stale catalog (503)', blocked.status === 503 && blocked.body.error.code === 'CATALOG_SYNC_UNAVAILABLE', blocked.body);
    r.check('order not yet updated', (await tracking(c.token, o.id)).status === 'partner_assigned');
    compose('start rabbitmq');
    r.step('RabbitMQ started');
    r.check('after recovery the outbox is flushed → OUT_FOR_DELIVERY', await waitStatus(c.token, o.id, 'out_for_delivery', 120_000));
    await agentDo(agent, 'arrived');
    const code = await otpFromEmail(c.email);
    r.check('delivery completes after recovery', (await agentDo(agent, 'verify-otp', { otp: code })).status === 200 && (await waitStatus(c.token, o.id, 'delivered')));
    return c.token;
  },

  async 'notification-outage'(r) {
    const c = await newCustomer('notify');
    const o = await placeOrder(c.token);
    r.orderId = o.id;
    r.step(`order ${o.orderNumber} placed`);
    compose('stop notification-service');
    r.step('notification-service stopped');
    const cancel = await api('POST', `/orders/${o.id}/cancel`, { token: c.token, body: { reason: 'Notification outage demo' } });
    r.check('order cancelled immediately (notifications never block orders)', cancel.status === 200);
    await sleep(3000);
    r.check('no email while the service is down', (await inbox(c.email)).length === 0);
    const depth = await waitFor(async () => {
      const q = await rabbit('GET', '/queues/%2F/notification-service.order-events');
      return q?.messages >= 1 ? q.messages : null;
    }, 15_000);
    r.check('the event waits in the durable notification queue', depth >= 1, depth);
    startOnly('notification-service');
    r.step('notification-service started');
    const mails = await waitFor(async () => ((await inbox(c.email)).length ? inbox(c.email) : null), 90_000);
    await sleep(3000);
    r.check('exactly one cancellation email after recovery', mails?.length === 1 && (await inbox(c.email)).length === 1, mails?.map((m) => m.Subject));
    return c.token;
  },

  async 'agent-auth'(r) {
    const c = await newCustomer('agentauth');
    const o = await placeOrder(c.token);
    r.orderId = o.id;
    await pay(c.token, o.id);
    const agent = await assignedPartner(c.token, o.id);
    r.step(`order ${o.orderNumber} assigned to ${agent.name}`);
    const otherName = DEMO_AGENTS.find((n) => n !== agent.name);
    const other = { token: (await api('POST', '/auth/login', { body: { email: agentEmail(otherName), password: agentPassword() } })).body.data.accessToken, deliveryId: agent.deliveryId };
    r.check(`another partner (${otherName}) cannot pick it up → 404`, (await agentDo(other, 'pickup')).status === 404);
    r.check('the customer cannot act as a partner → 403', (await api('POST', `/deliveries/${agent.deliveryId}/pickup`, { token: c.token })).status === 403);
    r.check('no token → 401', (await api('POST', `/deliveries/${agent.deliveryId}/pickup`)).status === 401);
    r.check('a body cannot impersonate the partner (strict schema / JWT identity) → 404', (await api('POST', `/deliveries/${agent.deliveryId}/pickup`, { token: other.token, body: { agentId: 'x' } })).status === 404);
    r.check('the assigned partner can pick up', (await agentDo(agent, 'pickup')).status === 200);
    await agentDo(agent, 'arrived');
    const code = await otpFromEmail(c.email);
    r.check('another partner cannot submit the code → 404', (await agentDo(other, 'verify-otp', { otp: code })).status === 404);
    const wrong = await agentDo(agent, 'verify-otp', { otp: code === '000000' ? '111111' : '000000' });
    r.check('wrong code → 422 with attempts remaining', wrong.status === 422 && /attempt/.test(wrong.body.error.message), wrong.body);
    r.check('correct code by the assigned partner → delivered', (await agentDo(agent, 'verify-otp', { otp: code })).status === 200 && (await waitStatus(c.token, o.id, 'delivered')));
    return c.token;
  },
};

const ORDER = ['success', 'payment-retry', 'expiry', 'cancel-refund', 'duplicates', 'rabbitmq-outage', 'notification-outage', 'agent-auth'];
const TITLES = {
  success: 'Complete successful order and delivery',
  'payment-retry': 'Payment failure and retry',
  expiry: 'Order expiration (unpaid)',
  'cancel-refund': 'Cancellation and refund',
  duplicates: 'Duplicate-event handling',
  'rabbitmq-outage': 'RabbitMQ outage and recovery',
  'notification-outage': 'Notification outage and recovery',
  'agent-auth': 'Delivery-agent authorization failures',
};

function markdown(runs) {
  const lines = [`# Scenario run — ${new Date().toISOString()}`, '', '| # | Scenario | Result | Checks | Order | Final state | Time |', '|---|---|---|---|---|---|---|'];
  runs.forEach((r, i) => lines.push(`| ${ORDER.indexOf(r.id) + 1} | ${r.title} | ${r.passed ? '✅ passed' : '❌ failed'} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} | \`${r.orderId ?? '—'}\` | ${r.finalState ? `${r.finalState.status} / ${r.finalState.paymentStatus}${r.finalState.deliveryStatus ? ` / ${r.finalState.deliveryStatus}` : ''}` : '—'} | ${r.durationS}s |`));
  for (const r of runs) {
    lines.push('', `## ${ORDER.indexOf(r.id) + 1}. ${r.title} — ${r.passed ? 'passed' : 'FAILED'}`, '', `Order: \`${r.orderId ?? '—'}\``, '', '**Steps**', ...r.steps.map((s) => `- ${s}`), '', '**Checks**', ...r.checks.map((c) => `- ${c.ok ? '✔' : '✘'} ${c.name}${c.info ? ` — \`${c.info}\`` : ''}`));
    if (r.finalState) lines.push('', `**Final state:** ${r.finalState.status} (payment ${r.finalState.paymentStatus}${r.finalState.deliveryStatus ? `, delivery ${r.finalState.deliveryStatus}` : ''}); history ${r.finalState.history.join(' → ')}`);
    if (r.events.length) lines.push('', '**Events observed (food.events)**', '', '| Routing key | Source | Event id | Correlation id |', '|---|---|---|---|', ...r.events.map((e) => `| ${e.key} | ${e.source} | \`${e.eventId}\` | \`${e.correlationId ?? ''}\` |`));
    if (r.errors.length) lines.push('', '**Errors**', ...r.errors.map((e) => `- ${e}`));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === 'list') {
    console.log('Scenarios:');
    ORDER.forEach((id, i) => console.log(`  ${i + 1}. ${id.padEnd(20)} ${TITLES[id]}`));
    console.log('\nnode scripts/scenarios.mjs all | <name|number> …');
    return;
  }
  const chosen = args[0] === 'all' ? ORDER : args.map((a) => (/^\d+$/.test(a) ? ORDER[Number(a) - 1] : a));
  for (const id of chosen) if (!SCENARIOS[id]) throw new Error(`Unknown scenario "${id}" (try: list)`);
  if (!agentPassword()) throw new Error('DELIVERY_AGENT_PASSWORD missing — run node scripts/init-env.mjs');

  console.log('Preparing: seeding delivery partners, short delivery timings, event recorder');
  await waitFor(() => health('delivery'), 90_000, 1000);
  execSync('node scripts/seed-delivery-agents.mjs', { stdio: 'ignore' });
  compose('up -d delivery-service', FAST_DELIVERY);
  await waitFor(() => health('delivery'), 90_000, 1000);
  await recorder.start();

  const runs = [];
  try {
    for (const id of chosen) {
      const r = new Run(id, TITLES[id]);
      console.log(`\n${ORDER.indexOf(id) + 1}. ${r.title}`);
      let token;
      try {
        token = await SCENARIOS[id](r);
      } catch (err) {
        r.errors.push(String(err.stack ?? err).split('\n').slice(0, 3).join(' | '));
        console.log(`    ✘ error: ${err.message}`);
        if (id === 'rabbitmq-outage') compose('start rabbitmq');
        if (id === 'notification-outage') startOnly('notification-service');
      }
      await r.finish(token);
      if (r.finalState) console.log(`  → final: ${r.finalState.status} / payment ${r.finalState.paymentStatus}${r.finalState.deliveryStatus ? ` / delivery ${r.finalState.deliveryStatus}` : ''} · ${r.events.length} events · order ${r.orderId}`);
      runs.push(r);
    }
  } finally {
    await recorder.stop();
    compose('up -d delivery-service'); // restore default timings
  }

  mkdirSync('reports/scenarios', { recursive: true });
  const md = markdown(runs);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`reports/scenarios/${stamp}.md`, md);
  writeFileSync('reports/scenarios/latest.md', md);
  writeFileSync('reports/scenarios/latest.json', `${JSON.stringify(runs.map(({ startedAt, ...r }) => ({ ...r, passed: r.passed })), null, 2)}\n`);
  console.log(`\n${md.split('\n').slice(2, 4 + runs.length).join('\n')}`);
  console.log(`\nReport: reports/scenarios/latest.md (and latest.json)`);
  process.exit(runs.every((r) => r.passed) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
