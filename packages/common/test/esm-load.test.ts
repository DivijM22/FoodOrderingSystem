import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Vitest transforms imports, so it can hide problems that only appear in plain Node ESM
 * (e.g. named imports from CommonJS packages). This loads the *built* package the way the
 * service containers do. `npm test` builds @food/common first.
 */
describe('built package loads in plain Node ESM', () => {
  it('imports dist/index.js without errors', () => {
    const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(dist)}); console.log(Object.keys(m).length)`], { encoding: 'utf8' });
    expect(Number(out.trim())).toBeGreaterThan(20);
  });
});
