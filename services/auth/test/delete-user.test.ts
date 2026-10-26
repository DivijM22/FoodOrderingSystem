import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, eventDataSchemas, EventTypes, OutboxModel } from '@food/common';
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

const password = 'secret123';
let admin: { authorization: string };
let adminId: string;

async function login(email: string) {
  const res = await request(app).post('/auth/login').send({ email, password }).expect(200);
  return { auth: { authorization: `Bearer ${res.body.data.accessToken}` }, id: res.body.data.user.id as string };
}

async function create(role: string, email: string, isActive = false) {
  const res = await request(app).post('/auth/users').set(admin).send({ name: 'Test User', email, password, role }).expect(201);
  if (!isActive) await request(app).patch(`/auth/users/${res.body.data.id}/status`).set(admin).send({ isActive: false }).expect(200);
  return res.body.data.id as string;
}

const deletedEvents = async () => (await OutboxModel.find({ eventType: EventTypes.AuthUserDeleted }).lean()).map((e) => e.envelope);

beforeEach(async () => {
  await service.ensureAdmin({ email: 'admin@food.local', password, name: 'Admin' });
  ({ auth: admin, id: adminId } = await login('admin@food.local'));
});

describe('DELETE /auth/users/:id', () => {
  it('deletes an inactive account and writes exactly one auth.user.deleted.v1 to the outbox', async () => {
    const id = await create('customer', 'c@example.com');
    const res = await request(app).delete(`/auth/users/${id}`).set(admin).expect(200);
    expect(res.body.data).toMatchObject({ id, role: 'customer' });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    expect(await UserModel.exists({ _id: id })).toBeNull();

    const [event, ...rest] = await deletedEvents();
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({ eventType: 'auth.user.deleted', version: 1, source: 'auth-service' });
    expect(eventDataSchemas[EventTypes.AuthUserDeleted].parse(event!.data)).toMatchObject({ userId: id, role: 'customer' });

    // A repeated request: 404 and no second event.
    const again = await request(app).delete(`/auth/users/${id}`).set(admin).expect(404);
    expect(again.body.error.code).toBe('NOT_FOUND');
    expect(await deletedEvents()).toHaveLength(1);
  });

  it('requires the account to be inactive', async () => {
    const id = await create('restaurant_admin', 'r@example.com', true);
    const res = await request(app).delete(`/auth/users/${id}`).set(admin).expect(409);
    expect(res.body.error.code).toBe('USER_ACTIVE');
    expect(await UserModel.exists({ _id: id })).not.toBeNull();
    expect(await deletedEvents()).toHaveLength(0);
  });

  it('refuses self-deletion, unknown ids and malformed ids', async () => {
    expect((await request(app).delete(`/auth/users/${adminId}`).set(admin).expect(403)).body.error.code).toBe('CANNOT_DELETE_SELF');
    await request(app).delete('/auth/users/0123456789abcdef01234567').set(admin).expect(404);
    await request(app).delete('/auth/users/not-an-id').set(admin).expect(400);
    expect(await deletedEvents()).toHaveLength(0);
  });

  it('is platform-admin only', async () => {
    const id = await create('customer', 'victim@example.com');
    await request(app).delete(`/auth/users/${id}`).expect(401);
    for (const role of ['customer', 'restaurant_admin', 'delivery_agent']) {
      const email = `${role}@example.com`;
      await create(role, email, true);
      const { auth } = await login(email);
      await request(app).delete(`/auth/users/${id}`).set(auth).expect(403);
    }
    expect(await UserModel.exists({ _id: id })).not.toBeNull();
  });

  it('refuses a caller whose admin account was deactivated (still-valid JWT)', async () => {
    await create('platform_admin', 'a2@example.com', true);
    const second = await login('a2@example.com');
    const target = await create('customer', 'c@example.com');
    await request(app).patch(`/auth/users/${second.id}/status`).set(admin).send({ isActive: false }).expect(200);
    const res = await request(app).delete(`/auth/users/${target}`).set(second.auth).expect(403);
    expect(res.body.error.code).toBe('ACTOR_NOT_ACTIVE');
  });

  it('refuses deleting a delivery agent who holds an active delivery (event-fed projection)', async () => {
    const id = await create('delivery_agent', 'agent@example.com');
    await service.recordAgentDelivery('d1', id);
    expect((await request(app).delete(`/auth/users/${id}`).set(admin).expect(409)).body.error.code).toBe('AGENT_HAS_ACTIVE_DELIVERY');
    await service.recordAgentDelivery('d1', id); // duplicate assignment event: harmless
    await service.closeAgentDelivery('d1', id);
    await service.recordAgentDelivery('d1', id); // delayed assignment after completion: closed stays closed
    await request(app).delete(`/auth/users/${id}`).set(admin).expect(200);
  });
});

describe('last active platform admin', () => {
  it('cannot be deactivated, while another admin can', async () => {
    const second = await create('platform_admin', 'a2@example.com', true);
    await request(app).patch(`/auth/users/${second}/status`).set(admin).send({ isActive: false }).expect(200);
    // Now the bootstrap admin is the only active one; a reactivated second admin may not deactivate it once alone.
    await request(app).patch(`/auth/users/${second}/status`).set(admin).send({ isActive: true }).expect(200);
    const other = await login('a2@example.com');
    await request(app).patch(`/auth/users/${adminId}/status`).set(other.auth).send({ isActive: false }).expect(200);
    const res = await request(app).patch(`/auth/users/${second}/status`).set(admin).send({ isActive: false });
    // `admin` is inactive now, but its JWT is still valid: the guard still refuses to leave zero active admins.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ACTIVE_ADMIN');
  });

  it('two admins deactivating each other concurrently leave one active', async () => {
    const second = await create('platform_admin', 'a2@example.com', true);
    const other = await login('a2@example.com');
    const results = await Promise.all([
      request(app).patch(`/auth/users/${second}/status`).set(admin).send({ isActive: false }),
      request(app).patch(`/auth/users/${adminId}/status`).set(other.auth).send({ isActive: false }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await UserModel.countDocuments({ role: 'platform_admin', isActive: true })).toBe(1);
  });
});
