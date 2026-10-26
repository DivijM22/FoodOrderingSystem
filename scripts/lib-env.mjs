// Tiny .env reader for the scripts (values in process.env win). Never prints anything.
import { existsSync, readFileSync } from 'node:fs';

export function env(name, fallback) {
  if (process.env[name]) return process.env[name];
  if (existsSync('.env')) {
    const m = readFileSync('.env', 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return fallback;
}
