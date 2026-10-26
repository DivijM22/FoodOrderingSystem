#!/usr/bin/env node
/**
 * Development-only console (never part of a production deployment).
 *   /          testing console (static page; calls the API gateway directly, exactly like a real client)
 *   /docs      Swagger UI for docs/openapi.json
 *   /devtools/api/*  read-only observability helpers that need server-side credentials or internal hosts:
 *     health      health of the gateway, all 7 services, RabbitMQ and Mailpit
 *     queues      RabbitMQ queue depths/consumers (devtools broker user: monitoring tag, no business rights)
 *     dlq         metadata of dead-lettered messages (type, ids, last error) — never payloads
 *     events      recent general events (metadata only), filterable by order id
 *     mail        Mailpit search/read for a test customer (local email capture)
 * Users sign in through the real Auth Service from the browser; this server holds no user credentials.
 * No database access, no broker credentials, no OTP verifiers. Refuses to start with NODE_ENV=production.
 * Dependency-free (Node 24 built-ins).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

if (process.env.NODE_ENV === 'production') {
  console.error('devtools is a development-only console and refuses to run with NODE_ENV=production');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3100);
const ROOT = new URL('.', import.meta.url).pathname;
const GATEWAY = process.env.GATEWAY_URL ?? 'http://gateway';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
const RABBIT_API = process.env.RABBITMQ_API ?? 'http://rabbitmq:15672/api';
const RABBIT_AUTH = `Basic ${Buffer.from(`devtools:${process.env.RABBITMQ_DEVTOOLS_PASSWORD ?? ''}`).toString('base64')}`;
const PUBLIC = {
  gatewayUrl: process.env.PUBLIC_GATEWAY_URL ?? 'http://localhost:8080',
  mailpitUrl: process.env.PUBLIC_MAILPIT_URL ?? 'http://localhost:8025',
  rabbitmqUrl: process.env.PUBLIC_RABBITMQ_URL ?? 'http://localhost:15672',
};
const SERVICES = [
  ['auth-service', 'http://auth-service:4001/health'],
  ['catalog-service', 'http://catalog-service:4002/health'],
  ['order-service', 'http://order-service:4003/health'],
  ['payment-service', 'http://payment-service:4004/health'],
  ['billing-service', 'http://billing-service:4005/health'],
  ['notification-service', 'http://notification-service:4006/health'],
  ['delivery-service', 'http://delivery-service:4007/health'],
];
const EVENTS_QUEUE = 'devtools.events';
const OTP_DLQ = 'notification-service.delivery-otp.dlq';

const log = (msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), service: 'devtools', msg, ...extra }));

async function fetchJson(url, init = {}, timeoutMs = 3000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}
const rabbit = (path, init = {}) => fetchJson(`${RABBIT_API}${path}`, { ...init, headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json', ...(init.headers ?? {}) } });

// ------------------------------------------------------------------ event tracer (metadata only)

const recent = [];
const MAX_EVENTS = 5000;
let tracerReady = false;

async function ensureTracerQueue() {
  // Bounded and self-expiring, so it never grows while the console is not running.
  await rabbit(`/queues/%2F/${EVENTS_QUEUE}`, { method: 'PUT', body: JSON.stringify({ durable: false, auto_delete: false, arguments: { 'x-max-length': 5000, 'x-message-ttl': 600000 } }) });
  const b = await rabbit(`/bindings/%2F/e/food.events/q/${EVENTS_QUEUE}`, { method: 'POST', body: JSON.stringify({ routing_key: '#' }) });
  tracerReady = b.status < 300;
}

async function pollEvents() {
  try {
    if (!tracerReady) await ensureTracerQueue();
    const got = await rabbit(`/queues/%2F/${EVENTS_QUEUE}/get`, { method: 'POST', body: JSON.stringify({ count: 200, ackmode: 'ack_requeue_false', encoding: 'auto', truncate: 100000 }) });
    if (got.status === 404) tracerReady = false;
    for (const m of Array.isArray(got.body) ? got.body : []) {
      let e;
      try {
        e = JSON.parse(m.payload);
      } catch {
        continue;
      }
      recent.push({
        routingKey: m.routing_key,
        eventType: e.eventType,
        eventId: e.eventId,
        source: e.source,
        occurredAt: e.occurredAt,
        correlationId: e.correlationId ?? null,
        aggregateId: e.aggregateId ?? null,
        orderId: e.data?.orderId ?? null,
        // A few non-sensitive fields that make a timeline readable.
        summary: e.data?.status ?? e.data?.agentName ?? (e.data?.finalAmount !== undefined ? `finalAmount ${e.data.finalAmount}` : e.data?.reason ?? null),
      });
    }
    if (recent.length > MAX_EVENTS) recent.splice(0, recent.length - MAX_EVENTS);
  } catch {
    tracerReady = false; // broker down: retry next tick
  }
}
setInterval(() => void pollEvents(), 1500).unref();

// ------------------------------------------------------------------ API handlers

async function health() {
  const probe = async (name, url) => {
    try {
      const r = await fetchJson(url, {}, 2500);
      return { name, httpStatus: r.status, status: r.body?.status ?? (r.status === 200 ? 'ok' : 'unhealthy'), checks: r.body?.checks ?? {}, uptimeSeconds: r.body?.uptimeSeconds ?? null };
    } catch (err) {
      return { name, httpStatus: 0, status: 'unreachable', checks: {}, error: String(err.cause?.code ?? err.message) };
    }
  };
  const [gateway, ...services] = await Promise.all([probe('gateway', `${GATEWAY}/health`), ...SERVICES.map(([n, u]) => probe(n, u))]);
  let rabbitmq;
  try {
    const o = await rabbit('/overview');
    rabbitmq = o.status === 200 ? { status: 'ok', version: o.body.rabbitmq_version, queues: o.body.object_totals?.queues, connections: o.body.object_totals?.connections } : { status: 'error', httpStatus: o.status };
  } catch (err) {
    rabbitmq = { status: 'unreachable', error: String(err.cause?.code ?? err.message) };
  }
  let mailpit;
  try {
    const i = await fetchJson(`${MAILPIT}/api/v1/info`);
    mailpit = i.status === 200 ? { status: 'ok', version: i.body.Version, messages: i.body.Messages } : { status: 'error' };
  } catch (err) {
    mailpit = { status: 'unreachable', error: String(err.cause?.code ?? err.message) };
  }
  // MongoDB is not probed directly (no database access from here): every service reports its own connection.
  const mongo = services.every((s) => s.checks.mongo === 'up') ? 'up (as seen by all services)' : `down for: ${services.filter((s) => s.checks.mongo !== 'up').map((s) => s.name).join(', ')}`;
  return { gateway, services, rabbitmq, mailpit, mongo, checkedAt: new Date().toISOString() };
}

async function queues() {
  const r = await rabbit('/queues/%2F?columns=name,messages,messages_ready,messages_unacknowledged,consumers');
  if (r.status !== 200) return { error: `RabbitMQ API returned ${r.status}` };
  return r.body.filter((q) => q.name !== EVENTS_QUEUE && !q.name.startsWith('e2e.')).map((q) => ({ name: q.name, messages: q.messages ?? 0, consumers: q.consumers ?? 0, kind: q.name.endsWith('.dlq') ? 'dlq' : q.name.endsWith('.retry') ? 'retry' : 'main' }));
}

async function deadLetters() {
  const qs = await queues();
  if (!Array.isArray(qs)) return qs;
  const out = [];
  for (const q of qs.filter((x) => x.kind === 'dlq' && x.messages > 0)) {
    if (q.name === OTP_DLQ) {
      out.push({ queue: q.name, messages: q.messages, note: 'Restricted OTP queue: contents are not readable by this console (by design).', items: [] });
      continue;
    }
    // Peek and requeue (ack_requeue_true): nothing is removed; payloads are reduced to metadata.
    const got = await rabbit(`/queues/%2F/${encodeURIComponent(q.name)}/get`, { method: 'POST', body: JSON.stringify({ count: 10, ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 100000 }) });
    const items = (Array.isArray(got.body) ? got.body : []).map((m) => {
      let e = {};
      try {
        e = JSON.parse(m.payload);
      } catch {
        /* malformed message */
      }
      return {
        eventType: e.eventType ?? m.properties?.type ?? '(unparseable)',
        eventId: e.eventId ?? m.properties?.message_id ?? null,
        correlationId: e.correlationId ?? null,
        orderId: e.data?.orderId ?? e.aggregateId ?? null,
        retries: m.properties?.headers?.['x-retry-count'] ?? 0,
        lastError: String(m.properties?.headers?.['x-last-error'] ?? (m.properties?.headers?.['x-death'] ? 'rejected (malformed or unroutable)' : '')).slice(0, 300),
      };
    });
    out.push({ queue: q.name, messages: q.messages, items });
  }
  return out;
}

async function mailFor(to) {
  const r = await fetchJson(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
  return (r.body?.messages ?? []).map((m) => ({ id: m.ID, subject: m.Subject, created: m.Created, snippet: m.Snippet }));
}
async function mailMessage(id) {
  const r = await fetchJson(`${MAILPIT}/api/v1/message/${encodeURIComponent(id)}`);
  if (r.status !== 200) return null;
  return { id: r.body.ID, subject: r.body.Subject, to: (r.body.To ?? []).map((t) => t.Address), created: r.body.Date, text: r.body.Text };
}

// ------------------------------------------------------------------ HTTP

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.map': 'application/json', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function serveFile(res, base, rel) {
  const file = normalize(join(base, rel));
  if (!file.startsWith(base)) return send(res, 404, { error: 'not found' });
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(await readFile(file));
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const SWAGGER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Food Platform API</title><link rel="stylesheet" href="/docs/swagger-ui.css">
<style>body{margin:0} .topbar{display:none}</style></head>
<body><div id="swagger"></div><script src="/docs/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger', deepLinking: true, persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true });</script>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { status: 'ok', service: 'devtools' });
    if (p === '/openapi.json') return serveFile(res, ROOT, 'openapi.json');
    if (p === '/docs' || p === '/docs/') return send(res, 200, SWAGGER_HTML, 'text/html; charset=utf-8');
    if (p.startsWith('/docs/')) return serveFile(res, join(ROOT, 'swagger-ui'), p.slice('/docs/'.length));
    if (p === '/devtools/api/config') return send(res, 200, PUBLIC);
    if (p === '/devtools/api/health') return send(res, 200, await health());
    if (p === '/devtools/api/queues') return send(res, 200, await queues());
    if (p === '/devtools/api/dlq') return send(res, 200, await deadLetters());
    if (p === '/devtools/api/events') {
      const orderId = url.searchParams.get('orderId');
      const rows = (orderId ? recent.filter((e) => e.orderId === orderId || e.aggregateId === orderId) : recent).slice(-Number(url.searchParams.get('limit') ?? 200));
      return send(res, 200, { tracing: tracerReady, events: rows });
    }
    if (p === '/devtools/api/mail') return send(res, 200, await mailFor(url.searchParams.get('to') ?? ''));
    if (p.startsWith('/devtools/api/mail/')) {
      const m = await mailMessage(p.slice('/devtools/api/mail/'.length));
      return m ? send(res, 200, m) : send(res, 404, { error: 'not found' });
    }
    if (p === '/' || p === '/index.html') return serveFile(res, join(ROOT, 'public'), 'index.html');
    return serveFile(res, join(ROOT, 'public'), p.slice(1));
  } catch (err) {
    log('request failed', { path: p, err: String(err.message) });
    return send(res, 502, { error: String(err.cause?.code ?? err.message) });
  }
});

server.listen(PORT, () => log('devtools listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
