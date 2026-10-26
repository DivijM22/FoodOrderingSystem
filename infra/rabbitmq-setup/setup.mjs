// One-shot broker provisioning (runs before the services start; idempotent, safe to re-run).
// Creates one RabbitMQ user per service with least-privilege permissions, pre-declares the exchanges,
// and restricts which routing keys each service may publish on the shared topic exchange.
// Uses the management HTTP API with the bootstrap admin (RABBITMQ_ADMIN_USER), which services never use.
const api = process.env.RABBITMQ_API ?? 'http://rabbitmq:15672/api';
const admin = `Basic ${Buffer.from(`${process.env.RABBITMQ_ADMIN_USER}:${process.env.RABBITMQ_ADMIN_PASSWORD}`).toString('base64')}`;
const VHOST = '%2F';
const EVENTS = 'food.events';
const RESTRICTED = 'food.restricted';
const esc = (s) => s.replaceAll('.', '\\.');

// service → which routing-key prefixes it may publish on food.events, and extra exchange rights.
const SERVICES = {
  // Publishes account lifecycle events (auth.user.deactivated / deleted) through its outbox; consumes delivery assignment events.
  auth: { publishes: '^auth\\.' },
  catalog: { publishes: '^catalog\\.restaurant\\.' },
  order: { publishes: '^(order|catalog\\.sync_requested)\\.' },
  payment: { publishes: '^payment\\.' },
  billing: { publishes: '^billing\\.' },
  // The only publisher of the restricted OTP command (write on food.restricted, no read, no configure).
  delivery: { publishes: '^delivery\\.', write: [RESTRICTED] },
  // The only consumer of the restricted exchange (read = may bind its own queue to it). Publishes nothing.
  notification: { publishes: '^$', read: [RESTRICTED] },
};

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, { method, headers: { authorization: admin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
}

async function waitForBroker() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${api}/overview`, { headers: { authorization: admin } });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('RabbitMQ management API not reachable');
}

await waitForBroker();

// Migration: queues created before per-service users dead-lettered through the default exchange, which
// the restricted users may not write to. Empty ones are deleted so their service recreates them with the
// new arguments; a non-empty one stops provisioning (never drop messages silently).
const queues = await (await fetch(`${api}/queues/${VHOST}`, { headers: { authorization: admin } })).json();
for (const q of queues) {
  if (!/^[a-z]+-service\./.test(q.name) || q.arguments?.['x-dead-letter-exchange'] !== '') continue;
  if ((q.messages ?? 0) > 0) throw new Error(`Legacy queue ${q.name} still holds ${q.messages} message(s); drain it, then re-run`);
  await call('DELETE', `/queues/${VHOST}/${encodeURIComponent(q.name)}?if-empty=true`);
  console.log(`migrated legacy queue ${q.name} (deleted; recreated by its service)`);
}
await call('PUT', `/exchanges/${VHOST}/${EVENTS}`, { type: 'topic', durable: true, auto_delete: false });
await call('PUT', `/exchanges/${VHOST}/${RESTRICTED}`, { type: 'direct', durable: true, auto_delete: false });

for (const [svc, rules] of Object.entries(SERVICES)) {
  const user = `${svc}-service`;
  const password = process.env[`RABBITMQ_${svc.toUpperCase()}_PASSWORD`];
  if (!password) throw new Error(`RABBITMQ_${svc.toUpperCase()}_PASSWORD is not set`);
  const own = `${esc(user)}\\..*`;
  const alt = (extra = []) => `^(${[esc(EVENTS), own, ...extra.map(esc)].join('|')})$`;
  await call('PUT', `/users/${user}`, { password, tags: '' });
  await call('PUT', `/permissions/${VHOST}/${user}`, {
    configure: `^(${esc(EVENTS)}|${own})$`,
    write: alt(rules.write),
    read: alt(rules.read),
  });
  await call('PUT', `/topic-permissions/${VHOST}/${user}`, { exchange: EVENTS, write: rules.publishes, read: '.*' });
  console.log(`provisioned ${user}`);
}

// Development console: monitoring tag (queue metadata), its own tracing queue bound to food.events,
// and read access to dead-letter queues for metadata peeks — except the restricted OTP DLQ. It can't
// publish anything (topic write '^$', no write outside its own devtools.* queue).
if (process.env.RABBITMQ_DEVTOOLS_PASSWORD) {
  await call('PUT', '/users/devtools', { password: process.env.RABBITMQ_DEVTOOLS_PASSWORD, tags: 'monitoring' });
  await call('PUT', `/permissions/${VHOST}/devtools`, {
    configure: '^devtools\\..*$',
    write: '^devtools\\..*$',
    read: `^(${esc(EVENTS)}|devtools\\..*|(?!notification-service\\.delivery-otp\\.)[a-z-]+-service\\.[a-z-]+\\.dlq)$`,
  });
  await call('PUT', `/topic-permissions/${VHOST}/devtools`, { exchange: EVENTS, write: '^$', read: '.*' });
  console.log('provisioned devtools (read-only console user)');
}
console.log('RabbitMQ provisioning complete');
