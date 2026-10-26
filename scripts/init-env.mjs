#!/usr/bin/env node
/**
 * Adds any missing local secrets to .env (creating it from .env.example first if needed).
 * Existing values are never changed, and no secret is printed. .env is git-ignored.
 *   node scripts/init-env.mjs
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

if (!existsSync('.env')) copyFileSync('.env.example', '.env');
let env = readFileSync('.env', 'utf8');
const has = (k) => new RegExp(`^${k}=.+$`, 'm').test(env);
const set = (k, v) => {
  env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  added.push(k);
};
const added = [];
const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');

if (!has('JWT_SECRET') || /change-me/.test(env.match(/^JWT_SECRET=(.*)$/m)?.[1] ?? '')) set('JWT_SECRET', secret(48));
if (!has('ADMIN_PASSWORD') || /change-me/.test(env.match(/^ADMIN_PASSWORD=(.*)$/m)?.[1] ?? '')) set('ADMIN_PASSWORD', `Adm1n-${secret(12)}`);
for (const svc of ['AUTH', 'CATALOG', 'ORDER', 'PAYMENT', 'BILLING', 'DELIVERY', 'NOTIFICATION', 'DEVTOOLS']) {
  if (!has(`RABBITMQ_${svc}_PASSWORD`)) set(`RABBITMQ_${svc}_PASSWORD`, secret());
}
if (!has('OTP_HMAC_KEY')) set('OTP_HMAC_KEY', secret(32));
if (!has('NOTIFICATION_OTP_PUBLIC_KEY') || !has('NOTIFICATION_OTP_PRIVATE_KEY')) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  set('NOTIFICATION_OTP_PUBLIC_KEY', publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  set('NOTIFICATION_OTP_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
}
if (!has('DELIVERY_AGENT_PASSWORD')) set('DELIVERY_AGENT_PASSWORD', `Agent-${secret(9)}`);

writeFileSync('.env', env);
console.log(added.length ? `Added to .env: ${added.join(', ')}` : '.env already has every secret');
