#!/usr/bin/env node
/**
 * OpenAPI tooling (no dependencies):
 *   node scripts/openapi.mjs build      writes docs/openapi.json from docs/openapi.mjs
 *   node scripts/openapi.mjs check      fails if the spec and the real Express routes / gateway routes disagree
 *   node scripts/openapi.mjs inventory  prints the API inventory as a Markdown table (from the spec + code)
 *
 * Routes are read from the source: each service's app.ts mounts (`app.use('/prefix', fooRouter(...))`) and the
 * `router.<method>('<path>'` declarations inside the matching `export function fooRouter` in src/routes/*.ts.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import spec from '../docs/openapi.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** All routes declared in the services' source code: [{ service, method, path }] (OpenAPI path syntax). */
export function codeRoutes() {
  const routes = [];
  for (const svc of readdirSync(join(ROOT, 'services'))) {
    const appFile = join(ROOT, 'services', svc, 'src', 'app.ts');
    const routesDir = join(ROOT, 'services', svc, 'src', 'routes');
    if (!existsSync(appFile) || !existsSync(routesDir)) continue;
    const mounts = {};
    for (const m of readFileSync(appFile, 'utf8').matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\(/g)) mounts[m[2]] = m[1];
    for (const file of readdirSync(routesDir)) {
      const src = readFileSync(join(routesDir, file), 'utf8');
      const parts = src.split(/export function (\w+)\(/);
      for (let i = 1; i < parts.length; i += 2) {
        const prefix = mounts[parts[i]];
        if (prefix === undefined) continue;
        for (const r of parts[i + 1].matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
          const path = (prefix + (r[2] === '/' ? '' : r[2])).replace(/:(\w+)/g, '{$1}');
          routes.push({ service: `${svc}-service`, method: r[1], path });
        }
      }
    }
  }
  return routes;
}

/** Path prefixes the nginx gateway proxies (location blocks), plus the health mapping. */
function gatewayPrefixes() {
  const conf = readFileSync(join(ROOT, 'infra', 'nginx', 'nginx.conf'), 'utf8');
  return [...conf.matchAll(/location (\/[a-z/]+) \{/g)].map((m) => m[1]);
}

function specOperations() {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths)) for (const method of METHODS) if (item[method]) ops.push({ path, method, op: item[method] });
  return ops;
}

function check() {
  const problems = [];
  const code = codeRoutes();
  const ops = specOperations();
  const key = (r) => `${r.method.toUpperCase()} ${r.path}`;
  const codeKeys = new Set(code.map(key));
  const specKeys = new Set(ops.filter((o) => !o.path.startsWith('/health')).map(key));
  for (const k of codeKeys) if (!specKeys.has(k)) problems.push(`implemented but not documented: ${k}`);
  for (const k of specKeys) if (!codeKeys.has(k)) problems.push(`documented but not implemented: ${k}`);
  const prefixes = gatewayPrefixes();
  for (const o of ops) {
    if (!o.path.startsWith('/health') && !prefixes.some((p) => o.path === p || o.path.startsWith(p.endsWith('/') ? p : `${p}/`) || o.path.startsWith(p))) problems.push(`not routed by the gateway: ${key(o)}`);
    if (!Array.isArray(o.op['x-roles']) || !o.op['x-roles'].length) problems.push(`no x-roles: ${key(o)}`);
    if (!o.op.responses || !Object.keys(o.op.responses).some((c) => c.startsWith('2'))) problems.push(`no success response: ${key(o)}`);
    if (!o.op.summary) problems.push(`no summary: ${key(o)}`);
    const params = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const p of params) if (!(o.op.parameters ?? []).some((x) => x.in === 'path' && x.name === p)) problems.push(`path parameter {${p}} not declared: ${key(o)}`);
    if (/notification|rabbit|mongo/i.test(o.path)) problems.push(`internal surface documented: ${key(o)}`);
  }
  if (problems.length) {
    console.error(`OpenAPI check failed (${problems.length}):\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`OpenAPI check passed: ${specKeys.size} business operations match the code (${code.length} routes), + ${ops.length - specKeys.size} gateway health operations; all routed by the gateway.`);
}

function inventory() {
  const code = codeRoutes();
  const owner = (o) => code.find((r) => r.path === o.path && r.method === o.method)?.service ?? 'gateway';
  const rows = specOperations().map((o) => {
    const all = ['customer', 'restaurant_admin', 'delivery_agent', 'platform_admin'];
    const roles = all.every((r) => o.op['x-roles'].includes(r)) ? 'any signed-in user' : o.op['x-roles'].map((r) => (r === 'optional-auth' ? 'public (token optional)' : r)).join(', ');
    return `| ${o.method.toUpperCase()} | \`${o.path}\` | ${owner(o)} | ${roles} | ${o.op.summary} |`;
  });
  console.log(['| Method | Path (via gateway :8080) | Owner | Auth / roles | Purpose |', '|---|---|---|---|---|', ...rows].join('\n'));
}

const cmd = process.argv[2] ?? 'check';
if (cmd === 'build') {
  writeFileSync(join(ROOT, 'docs', 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`docs/openapi.json written (${specOperations().length} operations)`);
} else if (cmd === 'check') check();
else if (cmd === 'inventory') inventory();
else {
  console.error('usage: node scripts/openapi.mjs build|check|inventory');
  process.exit(2);
}
