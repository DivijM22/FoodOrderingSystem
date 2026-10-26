import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { handleOrderEvent } from '../src/consumers/order-events.js';
import { AgentModel } from '../src/models/agent.model.js';
import { DeliveryModel } from '../src/models/delivery.model.js';
import { config, createHarness, oid, orderCancelled, orderConfirmed, seedAgents, token } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
/** An agent token with an explicit issue time (seconds), e.g. one minted before a deactivation. */
const tokenIssuedAt = (id: string, iat: number) =>
  jwt.sign({ sub: id, role: 'delivery_agent', name: 'A', email: 'a@example.com', iat }, config.JWT_SECRET, {
    algorithm: 'HS256', issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: '1h',
  });

async function confirmedAndReady(h: ReturnType<typeof createHarness>) {
  const orderId = oid();
  await handleOrderEvent(h.delivery, orderConfirmed(orderId));
  await h.delivery.promoteReady();
  return orderId;
}

describe('deactivated / deleted delivery agents (Auth events)', () => {
  it('a blocked agent receives no new assignment, goes offline, and cannot go available with an old token', async () => {
    const h = createHarness();
    const [a] = await seedAgents(1);
    expect(await h.delivery.blockAgent(a!._id, new Date(), 'disabled')).toBeNull();
    expect((await AgentModel.findById(a!._id).lean())!.status).toBe('offline');

    const res = await request(h.app).put('/deliveries/agents/me').set(auth(tokenIssuedAt(a!._id, Math.floor(Date.now() / 1000) - 60))).send({ available: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');

    await AgentModel.updateOne({ _id: a!._id }, { status: 'available' }); // even if it were marked available
    const orderId = await confirmedAndReady(h);
    await h.delivery.assignDue();
    expect((await DeliveryModel.findOne({ orderId }).lean())!.status).toBe('awaiting_partner');
  });

  it('a token issued after the deactivation (i.e. after reactivation + login) re-enables the agent', async () => {
    const h = createHarness();
    const [a] = await seedAgents(1, 'offline');
    await h.delivery.blockAgent(a!._id, new Date(Date.now() - 10_000), 'disabled');
    await request(h.app).put('/deliveries/agents/me').set(auth(token(a!._id, 'delivery_agent'))).send({ available: true }).expect(200);
    // A delayed duplicate of the old deactivation event does not block them again.
    await h.delivery.blockAgent(a!._id, new Date(Date.now() - 10_000), 'disabled');
    expect((await AgentModel.findById(a!._id).lean())!.status).toBe('available');
  });

  it('deletion is permanent, and an unregistered deleted agent cannot register', async () => {
    const h = createHarness();
    const [a] = await seedAgents(1);
    await h.delivery.blockAgent(a!._id, new Date(Date.now() - 10_000), 'deleted');
    const fresh = await request(h.app).put('/deliveries/agents/me').set(auth(token(a!._id, 'delivery_agent'))).send({ available: true });
    expect(fresh.body.error.code).toBe('ACCOUNT_DELETED');

    const ghost = oid();
    await h.delivery.blockAgent(ghost, new Date(), 'deleted');
    await h.delivery.blockAgent(ghost, new Date(), 'deleted'); // duplicate: harmless
    expect((await request(h.app).put('/deliveries/agents/me').set(auth(token(ghost, 'delivery_agent'))).send({ phone: '9876500011' })).status).toBe(403);
    expect(await AgentModel.exists({ _id: ghost })).toBeNull();
  });

  it('a delivery already held stays with the agent; on completion they go offline and history is kept', async () => {
    const h = createHarness();
    const [a] = await seedAgents(1);
    const orderId = await confirmedAndReady(h);
    await h.delivery.assignDue();
    const d = (await DeliveryModel.findOne({ orderId }).lean())!;
    expect(await h.delivery.blockAgent(a!._id, new Date(), 'deleted')).toBe(d._id.toString());
    expect((await AgentModel.findById(a!._id).lean())!.status).toBe('busy');

    // The agent's still-valid token can finish the job; cancellation also releases them — offline, not available.
    await handleOrderEvent(h.delivery, orderCancelled(orderId));
    const agent = (await AgentModel.findById(a!._id).lean())!;
    expect(agent.status).toBe('offline');
    expect(agent.activeDeliveryId).toBeUndefined();
    expect(await DeliveryModel.exists({ _id: d._id })).not.toBeNull();
  });
});
