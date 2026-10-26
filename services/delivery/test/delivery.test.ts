import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EventTypes, PermanentEventError } from '@food/common';
import { handleOrderEvent } from '../src/consumers/order-events.js';
import { AgentModel, maskPhone } from '../src/models/agent.model.js';
import { DeliveryModel } from '../src/models/delivery.model.js';
import { OtpModel } from '../src/models/otp.model.js';
import { generateOtp } from '../src/services/otp.js';
import { DeliveryScheduler } from '../src/workers/scheduler.js';
import { createHarness, logger, oid, orderCancelled, orderConfirmed, otpFromOutbox, outbox, seedAgents, token } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

/** Confirmed → prepared → assigned. Returns the delivery and its partner's token. */
async function assigned(h = createHarness()) {
  const [a] = await seedAgents(1);
  const orderId = oid();
  await handleOrderEvent(h.delivery, orderConfirmed(orderId));
  await h.delivery.promoteReady();
  await h.delivery.assignDue();
  const d = (await DeliveryModel.findOne({ orderId }).lean())!;
  expect(d.status).toBe('partner_assigned');
  return { h, d, id: d._id.toString(), orderId, agent: a!, agentToken: token(a!._id, 'delivery_agent', a!.name) };
}

async function arrived() {
  const ctx = await assigned();
  await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set('authorization', `Bearer ${ctx.agentToken}`).expect(200);
  await request(ctx.h.app).post(`/deliveries/${ctx.id}/arrived`).set('authorization', `Bearer ${ctx.agentToken}`).expect(200);
  return { ...ctx, otp: await otpFromOutbox(ctx.id) };
}

const verify = (ctx: { h: ReturnType<typeof createHarness>; id: string; agentToken: string }, otp: string) =>
  request(ctx.h.app).post(`/deliveries/${ctx.id}/verify-otp`).set('authorization', `Bearer ${ctx.agentToken}`).send({ otp });

describe('delivery creation (order.confirmed)', () => {
  it('creates one preparing delivery per confirmed order with order, customer, restaurant and address', async () => {
    const h = createHarness({ preparationDelayMs: 15_000 });
    const evt = orderConfirmed();
    expect(await handleOrderEvent(h.delivery, evt)).toBe('created');
    const d = (await DeliveryModel.findOne({ orderId: (evt.data as { orderId: string }).orderId }).lean())!;
    expect(d).toMatchObject({ status: 'preparing', customerId: 'cust-1', restaurantName: 'Spice Route', deliveryAddress: { city: 'Bengaluru' }, sourceEventId: evt.eventId });
    expect(d.prepareReadyAt!.getTime() - d.createdAt.getTime()).toBeGreaterThanOrEqual(14_900);
  });

  it('ignores duplicates: the same event, and a new event for the same order', async () => {
    const h = createHarness();
    const evt = orderConfirmed();
    await handleOrderEvent(h.delivery, evt);
    expect(await handleOrderEvent(h.delivery, evt)).toBe('duplicate');
    expect(await handleOrderEvent(h.delivery, { ...evt, eventId: crypto.randomUUID() })).toBe('duplicate');
    expect(await DeliveryModel.countDocuments()).toBe(1);
  });

  it('rejects unpaid or malformed confirmations permanently', async () => {
    const h = createHarness();
    await expect(handleOrderEvent(h.delivery, orderConfirmed(oid(), { amountPaid: 0 }))).rejects.toBeInstanceOf(PermanentEventError);
    await expect(handleOrderEvent(h.delivery, orderConfirmed(oid(), { customerEmail: undefined }))).rejects.toBeInstanceOf(PermanentEventError);
    await expect(handleOrderEvent(h.delivery, orderConfirmed(oid(), { paymentId: undefined }))).rejects.toBeInstanceOf(PermanentEventError);
    expect(await DeliveryModel.countDocuments()).toBe(0);
  });

  it('a confirmation delayed after the cancellation never starts a delivery (tombstone)', async () => {
    const h = createHarness();
    const orderId = oid();
    expect(await handleOrderEvent(h.delivery, orderCancelled(orderId))).toBe('tombstoned');
    expect(await handleOrderEvent(h.delivery, orderConfirmed(orderId))).toBe('closed');
    await h.delivery.promoteReady();
    expect((await DeliveryModel.findOne({ orderId }).lean())!.status).toBe('cancelled');
    expect(await outbox(EventTypes.DeliveryReadyForPickup)).toHaveLength(0);
  });
});

describe('preparation and assignment', () => {
  it('publishes ready_for_pickup only once the persisted preparation deadline passes', async () => {
    const h = createHarness({ preparationDelayMs: 60_000 });
    const orderId = oid();
    await handleOrderEvent(h.delivery, orderConfirmed(orderId));
    expect(await h.delivery.promoteReady()).toBe(0);
    expect(await h.delivery.promoteReady(new Date(Date.now() + 61_000))).toBe(1);
    expect(await h.delivery.promoteReady(new Date(Date.now() + 61_000))).toBe(0); // never twice
    const [evt] = await outbox(EventTypes.DeliveryReadyForPickup);
    expect(evt).toMatchObject({ source: 'delivery-service', aggregateId: orderId, correlationId: orderId, data: { orderId } });
    expect((await DeliveryModel.findOne({ orderId }).lean())!.status).toBe('awaiting_partner');
  });

  it('resumes due work after a restart (state lives in MongoDB, not timers)', async () => {
    const first = createHarness({ preparationDelayMs: 50 });
    await seedAgents(2);
    const orderId = oid();
    await handleOrderEvent(first.delivery, orderConfirmed(orderId));
    // "Crash" before anything ran; a brand-new instance picks the work up.
    await new Promise((r) => setTimeout(r, 80));
    const restarted = createHarness();
    const scheduler = new DeliveryScheduler(restarted.delivery, logger, 60_000);
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.stop();
    expect((await DeliveryModel.findOne({ orderId }).lean())!.status).toBe('partner_assigned');
  });

  it('assigns a random available partner and reserves them atomically', async () => {
    const h = createHarness();
    await seedAgents(6);
    const chosen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await handleOrderEvent(h.delivery, orderConfirmed());
    }
    await h.delivery.promoteReady();
    await h.delivery.assignDue();
    const ds = await DeliveryModel.find().lean();
    for (const d of ds) chosen.add(d.agentId!);
    expect(chosen.size).toBe(6); // each delivery got a distinct partner
    expect(await AgentModel.countDocuments({ status: 'busy' })).toBe(6);
    const evt = (await outbox(EventTypes.DeliveryPartnerAssigned))[0]!;
    expect(evt.data).toMatchObject({ agentName: expect.stringMatching(/^Agent /), agentPhoneMasked: expect.stringMatching(/^98X+\d\d$/) });
  });

  it('random choice: over many runs more than one partner gets picked first', async () => {
    const h = createHarness();
    await seedAgents(4);
    const firsts = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await handleOrderEvent(h.delivery, orderConfirmed());
      await h.delivery.promoteReady();
      await h.delivery.assignDue();
      const d = (await DeliveryModel.findOne({ status: 'partner_assigned' }).lean())!;
      firsts.add(d.agentId!);
      // complete instantly to free the partner for the next round
      await AgentModel.updateOne({ _id: d.agentId }, { $set: { status: 'available' }, $unset: { activeDeliveryId: 1 } });
      await DeliveryModel.updateOne({ _id: d._id }, { $set: { status: 'delivered' } });
    }
    expect(firsts.size).toBeGreaterThan(1);
  });

  it('no partner available: bounded retries, then assignment_failed (no refund, operator can retry)', async () => {
    const h = createHarness({ assignmentRetryMs: 1, assignmentMaxAttempts: 3 });
    const orderId = oid();
    await handleOrderEvent(h.delivery, orderConfirmed(orderId));
    await h.delivery.promoteReady();
    for (let i = 0; i < 3; i++) {
      await h.delivery.assignDue(new Date(Date.now() + 1000));
      const d = (await DeliveryModel.findOne({ orderId }).lean())!;
      expect(d).toMatchObject({ status: 'awaiting_partner', assignmentAttempts: i + 1 });
    }
    await h.delivery.assignDue(new Date(Date.now() + 1000));
    const failed = (await DeliveryModel.findOne({ orderId }).lean())!;
    expect(failed.status).toBe('assignment_failed');
    expect(await outbox(EventTypes.DeliveryAssignmentFailed)).toHaveLength(1);
    expect(await outbox(EventTypes.DeliveryCancelled)).toHaveLength(0);

    // A partner comes online; the operator re-queues the delivery.
    await seedAgents(1);
    await request(h.app).post(`/deliveries/${failed._id}/retry-assignment`).set('authorization', `Bearer ${token('admin', 'platform_admin')}`).expect(200);
    await h.delivery.assignDue();
    expect((await DeliveryModel.findOne({ orderId }).lean())!.status).toBe('partner_assigned');
  });

  it('assignment times out after ASSIGNMENT_TIMEOUT_MS even before the attempt limit', async () => {
    const h = createHarness({ assignmentTimeoutMs: 1000, assignmentMaxAttempts: 100 });
    const orderId = oid();
    await handleOrderEvent(h.delivery, orderConfirmed(orderId));
    await h.delivery.promoteReady();
    await h.delivery.assignDue(new Date(Date.now() + 5000));
    await h.delivery.assignDue(new Date(Date.now() + 5000));
    expect((await DeliveryModel.findOne({ orderId }).lean())!.status).toBe('assignment_failed');
  });

  it('concurrent schedulers never double-book a partner or a delivery', async () => {
    const a = createHarness();
    const b = createHarness();
    await seedAgents(3);
    for (let i = 0; i < 8; i++) await handleOrderEvent(a.delivery, orderConfirmed());
    await a.delivery.promoteReady();
    await Promise.all([a.delivery.assignDue(), b.delivery.assignDue(), a.delivery.assignDue(), b.delivery.assignDue()]);
    const assignedDs = await DeliveryModel.find({ status: 'partner_assigned' }).lean();
    expect(assignedDs).toHaveLength(3);
    expect(new Set(assignedDs.map((d) => d.agentId)).size).toBe(3);
    expect(await outbox(EventTypes.DeliveryPartnerAssigned)).toHaveLength(3);
    const agents = await AgentModel.find().lean();
    expect(agents.every((x) => x.status === 'busy' && assignedDs.some((d) => d._id.toString() === x.activeDeliveryId))).toBe(true);
  });
});

describe('pickup and arrival (assigned partner only)', () => {
  it('assigned partner picks up, then arrives; events published; history kept', async () => {
    const ctx = await assigned();
    const res = await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set('authorization', `Bearer ${ctx.agentToken}`).expect(200);
    expect(res.body.data.status).toBe('picked_up');
    const arr = await request(ctx.h.app).post(`/deliveries/${ctx.id}/arrived`).set('authorization', `Bearer ${ctx.agentToken}`).expect(200);
    expect(arr.body.data).toMatchObject({ status: 'arrived', otp: { status: 'active', attemptsRemaining: 5 } });
    expect(JSON.stringify(arr.body)).not.toMatch(/verifier|customerEmail|asha@example\.com/);
    const types = (await outbox()).map((e) => e.eventType);
    expect(types).toEqual(['delivery.ready_for_pickup', 'delivery.partner_assigned', 'delivery.picked_up', 'notification.delivery_otp', 'delivery.location_reached']);
    const reached = (await outbox(EventTypes.DeliveryLocationReached))[0]!;
    expect(JSON.stringify(reached)).not.toContain(await otpFromOutbox(ctx.id));
  });

  it('rejects other agents (404), other roles (403) and anonymous calls (401)', async () => {
    const ctx = await assigned();
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set('authorization', `Bearer ${token('someone-else', 'delivery_agent')}`).expect(404);
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set('authorization', `Bearer ${token('cust-1', 'customer')}`).expect(403);
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set('authorization', `Bearer ${token('admin', 'platform_admin')}`).expect(403);
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).expect(401);
    // An agent id in the body is never trusted (strict schemas / JWT identity only).
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set('authorization', `Bearer ${token('someone-else', 'delivery_agent')}`).send({ agentId: ctx.agent._id }).expect(404);
    expect((await DeliveryModel.findById(ctx.id).lean())!.status).toBe('partner_assigned');
  });

  it('enforces the order of steps and rejects duplicates', async () => {
    const ctx = await assigned();
    const auth = { authorization: `Bearer ${ctx.agentToken}` };
    expect((await request(ctx.h.app).post(`/deliveries/${ctx.id}/arrived`).set(auth).expect(409)).body.error.code).toBe('DELIVERY_NOT_PICKED_UP');
    expect((await verify(ctx, '123456').expect(409)).body.error.code).toBe('DELIVERY_NOT_ARRIVED');
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set(auth).expect(200);
    expect((await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set(auth).expect(409)).body.error.code).toBe('DELIVERY_ALREADY_PICKED_UP');
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/arrived`).set(auth).expect(200);
    expect((await request(ctx.h.app).post(`/deliveries/${ctx.id}/arrived`).set(auth).expect(409)).body.error.code).toBe('DELIVERY_ALREADY_ARRIVED');
    expect(await outbox(EventTypes.DeliveryPickedUp)).toHaveLength(1);
    expect(await outbox(EventTypes.DeliveryLocationReached)).toHaveLength(1);
    expect(await outbox(EventTypes.DeliveryOtpNotification)).toHaveLength(1);
  });

  it('a delivery that is still preparing cannot be acted on by anyone', async () => {
    const h = createHarness({ preparationDelayMs: 60_000 });
    await seedAgents(1);
    const orderId = oid();
    await handleOrderEvent(h.delivery, orderConfirmed(orderId));
    const d = (await DeliveryModel.findOne({ orderId }).lean())!;
    await request(h.app).post(`/deliveries/${d._id}/pickup`).set('authorization', `Bearer ${token('agent', 'delivery_agent')}`).expect(404);
  });
});

describe('OTP security', () => {
  it('codes are 6 digits from a CSPRNG with a broad spread', () => {
    const codes = Array.from({ length: 2000 }, generateOtp);
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(1990);
    expect(new Set(codes.map((c) => c[0])).size).toBe(10);
  });

  it('stores only a keyed verifier; the code appears nowhere in the database except sealed', async () => {
    const ctx = await arrived();
    const otpDoc = (await OtpModel.findOne({ deliveryId: ctx.id }).select('+verifier').lean())!;
    expect(otpDoc.verifier).toMatch(/^[a-f0-9]{64}$/);
    expect(otpDoc).toMatchObject({ status: 'active', attempts: 0, maxAttempts: 5, sequence: 1 });
    expect(otpDoc.expiresAt.getTime() - otpDoc.issuedAt.getTime()).toBe(300_000);
    for (const c of await mongoose.connection.db!.collections()) {
      const dump = JSON.stringify(await c.find().toArray());
      expect(dump.includes(`"${ctx.otp}"`) || dump.includes(`:${ctx.otp}`)).toBe(false);
    }
    const [cmd] = await outbox(EventTypes.DeliveryOtpNotification);
    expect(cmd).toMatchObject({ exchange: 'food.restricted', data: { customerEmail: 'asha@example.com', otpSequence: 1 } });
  });

  it('correct code → delivered, partner released, delivery.completed (otpVerified) published once', async () => {
    const ctx = await arrived();
    const res = await verify(ctx, ctx.otp).expect(200);
    expect(res.body.data.status).toBe('delivered');
    expect((await OtpModel.findOne({ deliveryId: ctx.id }).lean())!.status).toBe('consumed');
    expect((await AgentModel.findById(ctx.agent._id).lean())!).toMatchObject({ status: 'available', completedDeliveries: 1 });
    expect((await AgentModel.findById(ctx.agent._id).lean())!.activeDeliveryId).toBeUndefined();
    const done = await outbox(EventTypes.DeliveryCompleted);
    expect(done).toHaveLength(1);
    expect(done[0]!.data).toMatchObject({ otpVerified: true, agentId: ctx.agent._id });
    // Reuse is impossible.
    expect((await verify(ctx, ctx.otp).expect(409)).body.error.code).toBe('ALREADY_DELIVERED');
  });

  it('incorrect codes count attempts; the 5th wrong one locks the code', async () => {
    const ctx = await arrived();
    const wrong = ctx.otp === '000000' ? '111111' : '000000';
    for (let i = 4; i >= 1; i--) {
      const r = await verify(ctx, wrong).expect(422);
      expect(r.body.error).toMatchObject({ code: 'OTP_INVALID', message: expect.stringContaining(`${i} attempt`) });
    }
    expect((await verify(ctx, wrong).expect(423)).body.error.code).toBe('OTP_LOCKED');
    expect((await verify(ctx, ctx.otp).expect(423)).body.error.code).toBe('OTP_LOCKED'); // even the right code now
    expect(await outbox(EventTypes.DeliveryCompleted)).toHaveLength(0);
    expect((await DeliveryModel.findById(ctx.id).lean())!.status).toBe('arrived');
  });

  it('expired codes are refused', async () => {
    const ctx = await arrived();
    await OtpModel.updateOne({ deliveryId: ctx.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(ctx, ctx.otp).expect(410)).body.error.code).toBe('OTP_EXPIRED');
    expect((await OtpModel.findOne({ deliveryId: ctx.id }).lean())!.status).toBe('expired');
    expect(await outbox(EventTypes.DeliveryCompleted)).toHaveLength(0);
  });

  it('concurrent wrong submissions cannot exceed the attempt limit', async () => {
    const ctx = await arrived();
    const wrong = ctx.otp === '000000' ? '111111' : '000000';
    const results = await Promise.all(Array.from({ length: 20 }, () => verify(ctx, wrong)));
    const counted = results.filter((r) => r.status === 422 || (r.status === 423 && r.body.error.message.includes('Too many'))).length;
    expect(results.every((r) => r.status === 422 || r.status === 423)).toBe(true);
    expect((await OtpModel.findOne({ deliveryId: ctx.id }).lean())!.attempts).toBe(5);
    expect(counted).toBeGreaterThanOrEqual(5);
    expect(results.filter((r) => r.status === 422)).toHaveLength(4);
  });

  it('concurrent correct submissions complete the delivery exactly once', async () => {
    const ctx = await arrived();
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(ctx, ctx.otp)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 || r.status === 423)).toHaveLength(4);
    expect(await outbox(EventTypes.DeliveryCompleted)).toHaveLength(1);
  });

  it('reissue: supersedes the old code, respects the cooldown and the issue limit', async () => {
    const ctx = await arrived();
    const auth = { authorization: `Bearer ${ctx.agentToken}` };
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/resend-otp`).set(auth).expect(200);
    const second = await otpFromOutbox(ctx.id, 2);
    if (second !== ctx.otp) expect((await verify(ctx, ctx.otp)).status).toBe(422); // old code no longer valid
    await request(ctx.h.app).post(`/deliveries/${ctx.id}/resend-otp`).set(auth).expect(200);
    expect((await request(ctx.h.app).post(`/deliveries/${ctx.id}/resend-otp`).set(auth).expect(429)).body.error.code).toBe('OTP_RESEND_LIMIT');
    expect(await OtpModel.countDocuments({ deliveryId: ctx.id, status: 'active' })).toBe(1);
    await verify(ctx, await otpFromOutbox(ctx.id, 3)).expect(200);
  });

  it('reissue cooldown', async () => {
    const h = createHarness({ otpResendCooldownMs: 60_000 });
    const ctx = await assigned(h);
    const auth = { authorization: `Bearer ${ctx.agentToken}` };
    await request(h.app).post(`/deliveries/${ctx.id}/pickup`).set(auth).expect(200);
    await request(h.app).post(`/deliveries/${ctx.id}/arrived`).set(auth).expect(200);
    expect((await request(h.app).post(`/deliveries/${ctx.id}/resend-otp`).set(auth).expect(429)).body.error.code).toBe('OTP_RESEND_TOO_SOON');
  });
});

describe('cancellation', () => {
  it('before preparation completes: no ready event ever, delivery.cancelled published', async () => {
    const h = createHarness({ preparationDelayMs: 60_000 });
    const orderId = oid();
    await handleOrderEvent(h.delivery, orderConfirmed(orderId));
    expect(await handleOrderEvent(h.delivery, orderCancelled(orderId))).toBe('cancelled');
    expect(await h.delivery.promoteReady(new Date(Date.now() + 120_000))).toBe(0);
    expect((await outbox(EventTypes.DeliveryCancelled))[0]!.data).toMatchObject({ previousStatus: 'preparing' });
  });

  it('after assignment: partner released; duplicates publish nothing more', async () => {
    const ctx = await assigned();
    const evt = orderCancelled(ctx.orderId);
    expect(await handleOrderEvent(ctx.h.delivery, evt)).toBe('cancelled');
    expect(await handleOrderEvent(ctx.h.delivery, evt)).toBe('duplicate');
    expect(await handleOrderEvent(ctx.h.delivery, orderCancelled(ctx.orderId, 'again'))).toBe('ignored');
    expect((await AgentModel.findById(ctx.agent._id).lean())!.status).toBe('available');
    expect(await outbox(EventTypes.DeliveryCancelled)).toHaveLength(1);
    expect((await request(ctx.h.app).post(`/deliveries/${ctx.id}/pickup`).set('authorization', `Bearer ${ctx.agentToken}`).expect(409)).body.error.code).toBe('DELIVERY_CANCELLED');
  });

  it('after arrival: OTP invalidated, the order can never become delivered', async () => {
    const ctx = await arrived();
    await handleOrderEvent(ctx.h.delivery, orderCancelled(ctx.orderId));
    expect((await verify(ctx, ctx.otp).expect(409)).body.error.code).toBe('DELIVERY_CANCELLED');
    expect((await OtpModel.findOne({ deliveryId: ctx.id }).lean())!.status).toBe('cancelled');
    expect(await outbox(EventTypes.DeliveryCompleted)).toHaveLength(0);
  });

  it('a delivered order is never cancelled by a late event', async () => {
    const ctx = await arrived();
    await verify(ctx, ctx.otp).expect(200);
    expect(await handleOrderEvent(ctx.h.delivery, orderCancelled(ctx.orderId))).toBe('ignored');
    expect((await DeliveryModel.findById(ctx.id).lean())!.status).toBe('delivered');
  });
});

describe('agent profile', () => {
  it('is created from the JWT identity and controls availability', async () => {
    const h = createHarness();
    const t = token('agent-x', 'delivery_agent', 'Kiran P', 'kiran@food.local');
    expect((await request(h.app).put('/deliveries/agents/me').set('authorization', `Bearer ${t}`).send({ available: true }).expect(422)).body.error.code).toBe('PHONE_REQUIRED');
    const r = await request(h.app).put('/deliveries/agents/me').set('authorization', `Bearer ${t}`).send({ phone: '9876500011', available: true }).expect(200);
    expect(r.body.data).toMatchObject({ id: 'agent-x', name: 'Kiran P', email: 'kiran@food.local', status: 'available' });
    await request(h.app).put('/deliveries/agents/me').set('authorization', `Bearer ${t}`).send({ id: 'other' }).expect(400);
    await request(h.app).put('/deliveries/agents/me').set('authorization', `Bearer ${token('c', 'customer')}`).send({ phone: '9876500011' }).expect(403);
    expect(maskPhone('+919876500011')).toBe('+91 98XXXXXX11');
  });
});
