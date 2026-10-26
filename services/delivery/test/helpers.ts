import { randomUUID } from 'node:crypto';
import { createEnvelope, createLogger, EventTypes, OutboxModel, sealedBox, signAccessToken, type Role } from '@food/common';
import { createApp } from '../src/app.js';
import { AgentModel } from '../src/models/agent.model.js';
import { DeliveryService, type DeliveryRules } from '../src/services/delivery.service.js';

export const logger = createLogger('delivery-test', 'silent');
export const config = {
  JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-signing',
  JWT_ISSUER: 'food-auth-service',
  JWT_AUDIENCE: 'food-platform',
  CORS_ORIGINS: '*',
};
export const OTP_KEY = 'test-otp-hmac-key-that-is-at-least-32-chars';
export const keys = sealedBox.generateSealingKeyPair();
const privateKey = sealedBox.loadSealingPrivateKey(keys.privateKey);

export const RULES: DeliveryRules = {
  preparationDelayMs: 0,
  assignmentDelayMs: 0,
  assignmentRetryMs: 1000,
  assignmentMaxAttempts: 3,
  assignmentTimeoutMs: 60_000,
  otpTtlMs: 300_000,
  otpMaxAttempts: 5,
  otpMaxIssues: 3,
  otpResendCooldownMs: 0,
};

export const oid = () => randomUUID().replaceAll('-', '').slice(0, 24);

export function createHarness(rules: Partial<DeliveryRules> = {}) {
  let commits = 0;
  const delivery = new DeliveryService({ ...RULES, ...rules }, OTP_KEY, sealedBox.loadSealingPublicKey(keys.publicKey), logger, () => void commits++);
  const app = createApp(config, logger, { delivery, isBrokerConnected: () => true });
  return { delivery, app, commits: () => commits };
}

export const token = (id: string, role: Role, name = 'Test User', email = `${id}@example.com`) =>
  signAccessToken({ id, role, name, email }, { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: '1h' });

export async function seedAgents(n: number, status: 'available' | 'offline' = 'available') {
  const agents = Array.from({ length: n }, (_, i) => ({ _id: `agent${String(i).padStart(2, '0')}${oid().slice(0, 8)}`, name: `Agent ${i}`, email: `agent${i}@food.local`, phone: `98765432${String(i).padStart(2, '0')}`, status }));
  await AgentModel.insertMany(agents);
  return agents;
}

export function orderConfirmed(orderId = oid(), overrides: Record<string, unknown> = {}) {
  return createEnvelope({
    eventType: EventTypes.OrderConfirmed,
    version: 1,
    source: 'order-service',
    data: {
      orderId,
      orderNumber: `ORD-261017-${orderId.slice(-6).toUpperCase()}`,
      customerId: 'cust-1',
      restaurantId: 'rest-1',
      restaurantName: 'Spice Route',
      paymentId: 'pay-1',
      amountPaid: 45000,
      currency: 'INR',
      deliveryAddress: { line1: '7, MG Road', city: 'Bengaluru', pincode: '560001' },
      items: [{ menuItemId: 'm1', name: 'Biryani', quantity: 2 }],
      customerEmail: 'asha@example.com',
      customerName: 'Asha Rao',
      confirmedAt: new Date().toISOString(),
      ...overrides,
    },
  });
}

export function orderCancelled(orderId: string, reason = 'Changed my mind') {
  return createEnvelope({
    eventType: EventTypes.OrderCancelled,
    version: 1,
    source: 'order-service',
    data: {
      orderId, orderNumber: 'ORD-X', customerId: 'cust-1', restaurantId: 'rest-1', reason, cancelledBy: 'platform',
      previousStatus: 'confirmed', paymentStatus: 'paid', provisionalTotal: 45000, cancelledAt: new Date().toISOString(),
    },
  });
}

export const outbox = async (type?: string) => (await OutboxModel.find(type ? { eventType: type } : {}).sort({ createdAt: 1 }).lean()).map((o) => ({ ...o.envelope, exchange: o.exchange }));

/** Reads the OTP the way only the Notification Service can: by opening the sealed restricted command. */
export async function otpFromOutbox(deliveryId: string, sequence = 1): Promise<string> {
  const cmds = await outbox(EventTypes.DeliveryOtpNotification);
  const cmd = cmds.find((c) => (c.data as { deliveryId: string; otpSequence: number }).deliveryId === deliveryId && (c.data as { otpSequence: number }).otpSequence === sequence);
  if (!cmd) throw new Error('no OTP command');
  return sealedBox.open((cmd.data as { otpCiphertext: string }).otpCiphertext, privateKey);
}
