#!/usr/bin/env node
/**
 * Seeds 12 fictional delivery partners (repeatable, idempotent), through the API gateway:
 *   1. a platform admin creates each partner's account in the Auth Service (role delivery_agent);
 *   2. each partner logs in and registers their profile + availability with the Delivery Service
 *      (PUT /deliveries/agents/me — identity taken from their JWT, never from the request body).
 * The shared password comes from DELIVERY_AGENT_PASSWORD (.env, git-ignored; `node scripts/init-env.mjs`
 * generates one). Refuses to run against NODE_ENV=production. Prints no secrets.
 *   node scripts/seed-delivery-agents.mjs [--offline]
 */
import { env } from './lib-env.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo delivery partners in production');
  process.exit(1);
}
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const password = env('DELIVERY_AGENT_PASSWORD');
const adminEmail = env('ADMIN_EMAIL', 'admin@food.local');
const adminPassword = env('ADMIN_PASSWORD');
if (!password || !adminPassword) {
  console.error('DELIVERY_AGENT_PASSWORD and ADMIN_PASSWORD must be set (run node scripts/init-env.mjs)');
  process.exit(1);
}

const AGENTS = [
  ['Ravi Kumar', '9845012301'], ['Ananya Iyer', '9845012302'], ['Mohammed Faiz', '9845012303'], ['Priya Nair', '9845012304'],
  ['Arjun Reddy', '9845012305'], ['Sneha Kulkarni', '9845012306'], ['Vikram Singh', '9845012307'], ['Lakshmi Menon', '9845012308'],
  ['Rahul Das', '9845012309'], ['Kavya Shetty', '9845012310'], ['Imran Sheikh', '9845012311'], ['Divya Pillai', '9845012312'],
];
const agentEmail = (name) => `agent.${name.toLowerCase().replaceAll(' ', '.')}@food.local`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, { body, token } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ([429, 502, 503, 504].includes(res.status) && attempt < 30) {
      await sleep(1000); // gateway rate limit on /auth, or a service (re)starting
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

const available = !process.argv.includes('--offline');
const admin = await api('POST', '/auth/login', { body: { email: adminEmail, password: adminPassword } });
if (admin.status !== 200) {
  console.error('Admin login failed', admin.status);
  process.exit(1);
}
let created = 0;
let ok = 0;
for (const [name, phone] of AGENTS) {
  const email = agentEmail(name);
  const c = await api('POST', '/auth/users', { token: admin.body.data.accessToken, body: { name, email, password, phone, role: 'delivery_agent' } });
  if (c.status === 201) created++;
  else if (c.status !== 409) throw new Error(`creating ${email} failed: ${c.status} ${JSON.stringify(c.body)}`);
  const login = await api('POST', '/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`login for ${email} failed (${login.status}); was it created with another password?`);
  const p = await api('PUT', '/deliveries/agents/me', { token: login.body.data.accessToken, body: { phone, available } });
  if (p.status !== 200 && !(p.status === 409 && p.body?.error?.code === 'AGENT_BUSY')) throw new Error(`profile for ${email} failed: ${p.status} ${JSON.stringify(p.body)}`);
  ok++;
  await sleep(150);
}
console.log(`Delivery partners: ${ok} ready (${created} new accounts), availability=${available ? 'available' : 'offline'}`);
