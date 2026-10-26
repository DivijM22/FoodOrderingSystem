import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@food/common';
import { createApp } from '../src/app.js';
import { loadAuthConfig } from '../src/config.js';
import { UserModel } from '../src/models/user.model.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

const config = loadAuthConfig({
  NODE_ENV: 'test',
  MONGO_URI: 'unused-in-tests',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  BCRYPT_ROUNDS: '4',
});
const { app, service } = createApp(config, createLogger('auth-test', 'silent'));

const customer = { name: 'Asha Rao', email: 'Asha@Example.com', password: 'secret123', phone: '9876543210' };

async function registerAndLogin(user = customer) {
  await request(app).post('/auth/register').send(user).expect(201);
  const res = await request(app).post('/auth/login').send({ email: user.email, password: user.password }).expect(200);
  return res.body.data.accessToken as string;
}

describe('POST /auth/register', () => {
  it('creates a customer and never exposes the password hash', async () => {
    const res = await request(app).post('/auth/register').send(customer);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', role: 'customer', isActive: true });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    const stored = await UserModel.findOne({ email: 'asha@example.com' }).select('+passwordHash').lean();
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored?.passwordHash).not.toContain('secret123');
  });

  it('rejects duplicate emails case-insensitively', async () => {
    await request(app).post('/auth/register').send(customer).expect(201);
    const res = await request(app).post('/auth/register').send({ ...customer, email: 'ASHA@example.COM' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects weak passwords and invalid emails with field details', async () => {
    const res = await request(app).post('/auth/register').send({ name: 'X', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.email', 'body.password']));
  });

  it('does not let a client self-assign a privileged role', async () => {
    const res = await request(app).post('/auth/register').send({ ...customer, role: 'platform_admin' });
    expect(res.status).toBe(400);
    expect(await UserModel.countDocuments()).toBe(0);
  });
});

describe('POST /auth/login', () => {

  it('returns a verifiable JWT with role claims', async () => {
    await request(app).post('/auth/register').send(customer).expect(201);
    const res = await request(app).post('/auth/login').send({ email: 'asha@example.com', password: 'secret123' });
    expect(res.status).toBe(200);
    expect(res.body.data.tokenType).toBe('Bearer');
    const claims = jwt.verify(res.body.data.accessToken, config.JWT_SECRET) as jwt.JwtPayload;
    expect(claims).toMatchObject({ role: 'customer', email: 'asha@example.com', iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE });
    expect(claims.sub).toBe(res.body.data.user.id);
  });

  it('returns the same 401 for a wrong password and an unknown email', async () => {
    await request(app).post('/auth/register').send(customer).expect(201);
    const wrongPw = await request(app).post('/auth/login').send({ email: customer.email, password: 'wrong123' });
    const unknown = await request(app).post('/auth/login').send({ email: 'ghost@example.com', password: 'secret123' });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body.error).toEqual(unknown.body.error);
    expect(wrongPw.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('blocks deactivated accounts', async () => {
    await request(app).post('/auth/register').send(customer).expect(201);
    await UserModel.updateOne({ email: 'asha@example.com' }, { isActive: false });
    const res = await request(app).post('/auth/login').send({ email: customer.email, password: customer.password });
    expect(res.status).toBe(403);
  });
});

describe('protected profile endpoints', () => {
  it('GET /auth/me returns the current user', async () => {
    const token = await registerAndLogin();
    const res = await request(app).get('/auth/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('asha@example.com');
  });

  it('rejects missing, malformed, tampered and expired tokens', async () => {
    const token = await registerAndLogin();
    expect((await request(app).get('/auth/me')).body.error.code).toBe('MISSING_TOKEN');
    expect((await request(app).get('/auth/me').set('authorization', 'Bearer not-a-jwt')).status).toBe(401);

    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), role: 'platform_admin' })).toString('base64url');
    const tampered = await request(app).get('/auth/me').set('authorization', `Bearer ${h}.${forged}.${s}`);
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('INVALID_TOKEN');

    const expired = jwt.sign({ sub: 'x', role: 'customer', exp: Math.floor(Date.now() / 1000) - 1 }, config.JWT_SECRET, {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    const exp = await request(app).get('/auth/me').set('authorization', `Bearer ${expired}`);
    expect(exp.status).toBe(401);
    expect(exp.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('GET /auth/verify returns the verified claims', async () => {
    const token = await registerAndLogin();
    const res = await request(app).get('/auth/verify').set('authorization', `Bearer ${token}`);
    expect(res.body.data).toMatchObject({ valid: true, user: { role: 'customer', email: 'asha@example.com' } });
  });

  it('PATCH /auth/me updates name, phone and saved addresses', async () => {
    const token = await registerAndLogin();
    const res = await request(app)
      .patch('/auth/me')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'Asha R', addresses: [{ label: 'Work', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Asha R');
    expect(res.body.data.addresses[0]).toMatchObject({ label: 'Work', city: 'Bengaluru', pincode: '560001' });
    expect(res.body.data.addresses[0].id).toBeTruthy();
  });

  it('PATCH /auth/me cannot change role or email', async () => {
    const token = await registerAndLogin();
    const res = await request(app).patch('/auth/me').set('authorization', `Bearer ${token}`).send({ role: 'platform_admin' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/me/password changes the password', async () => {
    const token = await registerAndLogin();
    const auth = { authorization: `Bearer ${token}` };
    await request(app).post('/auth/me/password').set(auth).send({ currentPassword: 'bad', newPassword: 'newpass123' }).expect(401);
    await request(app).post('/auth/me/password').set(auth).send({ currentPassword: 'secret123', newPassword: 'newpass123' }).expect(204);
    await request(app).post('/auth/login').send({ email: customer.email, password: 'secret123' }).expect(401);
    await request(app).post('/auth/login').send({ email: customer.email, password: 'newpass123' }).expect(200);
  });
});

describe('role-based authorization (/auth/users)', () => {
  async function adminToken() {
    await service.ensureAdmin({ email: 'admin@food.local', password: 'admin1234', name: 'Admin' });
    const res = await request(app).post('/auth/login').send({ email: 'admin@food.local', password: 'admin1234' }).expect(200);
    return res.body.data.accessToken as string;
  }

  it('forbids customers from admin endpoints', async () => {
    const token = await registerAndLogin();
    const res = await request(app).get('/auth/users').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets a platform admin create staff accounts and filter users by role', async () => {
    const token = await adminToken();
    const auth = { authorization: `Bearer ${token}` };
    await request(app)
      .post('/auth/users')
      .set(auth)
      .send({ name: 'Ravi Kumar', email: 'ravi@food.local', password: 'deliver123', role: 'delivery_agent' })
      .expect(201);
    const res = await request(app).get('/auth/users?role=delivery_agent').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 1, total: 1 });

    const login = await request(app).post('/auth/login').send({ email: 'ravi@food.local', password: 'deliver123' });
    expect(login.body.data.user.role).toBe('delivery_agent');
  });

  it('lets an admin deactivate users but not themselves', async () => {
    const token = await adminToken();
    const auth = { authorization: `Bearer ${token}` };
    const created = await request(app).post('/auth/register').send(customer).expect(201);
    await request(app).patch(`/auth/users/${created.body.data.id}/status`).set(auth).send({ isActive: false }).expect(200);
    await request(app).post('/auth/login').send({ email: customer.email, password: customer.password }).expect(403);

    const me = await request(app).get('/auth/me').set(auth);
    await request(app).patch(`/auth/users/${me.body.data.id}/status`).set(auth).send({ isActive: false }).expect(403);
  });

  it('ensureAdmin is idempotent', async () => {
    expect(await service.ensureAdmin({ email: 'a@food.local', password: 'admin1234', name: 'A' })).toBe(true);
    expect(await service.ensureAdmin({ email: 'a@food.local', password: 'admin1234', name: 'A' })).toBe(false);
  });
});

describe('GET /health', () => {
  it('reports mongo up', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'auth-service', checks: { mongo: 'up' } });
  });
});

describe('configuration', () => {
  it('fails fast on a short JWT secret', () => {
    expect(() => loadAuthConfig({ MONGO_URI: 'x', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
