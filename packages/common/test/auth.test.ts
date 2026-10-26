import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { signAccessToken, verifyAccessToken, UnauthorizedError } from '../src/index.js';

const opts = { secret: 'x'.repeat(32), issuer: 'iss', audience: 'aud' };
const user = { id: 'u1', email: 'a@b.com', role: 'customer' as const, name: 'A' };

describe('JWT helpers', () => {
  it('round-trips a signed token', () => {
    const token = signAccessToken(user, { ...opts, expiresIn: '5m' });
    const verified = verifyAccessToken(token, opts);
    expect(verified).toMatchObject(user);
    expect(Math.abs(verified.issuedAt!.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('rejects a token signed with another secret', () => {
    const token = signAccessToken(user, { ...opts, secret: 'y'.repeat(32), expiresIn: '5m' });
    expect(() => verifyAccessToken(token, opts)).toThrow(UnauthorizedError);
  });

  it('rejects a token for another audience', () => {
    const token = signAccessToken(user, { ...opts, audience: 'other', expiresIn: '5m' });
    expect(() => verifyAccessToken(token, opts)).toThrow(/Invalid token/);
  });

  it('reports expired tokens distinctly', () => {
    const token = jwt.sign({ sub: 'u1', role: 'customer', exp: Math.floor(Date.now() / 1000) - 10 }, opts.secret, {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    try {
      verifyAccessToken(token, opts);
      expect.unreachable();
    } catch (err) {
      expect((err as UnauthorizedError).code).toBe('TOKEN_EXPIRED');
    }
  });

  it('rejects unknown roles', () => {
    const token = jwt.sign({ sub: 'u1', role: 'superuser' }, opts.secret, { issuer: 'iss', audience: 'aud' });
    expect(() => verifyAccessToken(token, opts)).toThrow(UnauthorizedError);
  });

  it('rejects the "none" algorithm', () => {
    const token = jwt.sign({ sub: 'u1', role: 'platform_admin' }, '', { algorithm: 'none', issuer: 'iss', audience: 'aud' });
    expect(() => verifyAccessToken(token, opts)).toThrow(UnauthorizedError);
  });
});
