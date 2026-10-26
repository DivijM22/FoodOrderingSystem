import { createEnvelope, ServiceUnavailableError, signAccessToken, type EventEnvelope, type EventPublisher, type Role } from '@food/common';
import { Types } from 'mongoose';
import type { CatalogGateway, CatalogMenu, CatalogRestaurant } from '../src/catalog/catalog.gateway.js';
import { loadOrderConfig } from '../src/config.js';

export const config = loadOrderConfig({
  NODE_ENV: 'test',
  MONGO_URI: 'unused-in-tests',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  RABBITMQ_URL: 'amqp://unused',
  CATALOG_SERVICE_URL: 'http://catalog.invalid',
});

export function userToken(role: Role, id = new Types.ObjectId().toString()) {
  const user = { id, role, email: `${role}-${id.slice(-4)}@test.local`, name: `Test ${role}` };
  const token = signAccessToken(user, {
    secret: config.JWT_SECRET,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    expiresIn: '5m',
  });
  return { ...user, header: { authorization: `Bearer ${token}` } };
}

const oid = () => new Types.ObjectId().toString();

export const OWNER_ID = oid();
export const ids = {
  restaurant: oid(),
  closedRestaurant: oid(),
  otherRestaurant: oid(),
  biryani: oid(), // ₹329
  paneer: oid(), // ₹279
  raita: oid(), // ₹49
  unavailable: oid(),
  otherItem: oid(),
};

/** In-memory stand-in for the Catalog Service. */
export class FakeCatalog implements CatalogGateway {
  down = false;
  menus = new Map<string, CatalogMenu>();
  restaurants = new Map<string, CatalogRestaurant>();

  constructor() {
    this.reset();
  }

  reset() {
    this.down = false;
    this.menus.clear();
    this.restaurants.clear();
    this.menus.set(ids.restaurant, {
      restaurant: { id: ids.restaurant, name: 'Spice Route Biryani House', isOpen: true, status: 'active' },
      items: [
        { id: ids.biryani, name: 'Chicken Dum Biryani', price: 32900, isVeg: false, isAvailable: true },
        { id: ids.paneer, name: 'Paneer Tikka', price: 27900, isVeg: true, isAvailable: true },
        { id: ids.raita, name: 'Raita', price: 4900, isVeg: true, isAvailable: true },
        { id: ids.unavailable, name: 'Qubani Ka Meetha', price: 14900, isVeg: true, isAvailable: false },
      ],
    });
    this.menus.set(ids.closedRestaurant, {
      restaurant: { id: ids.closedRestaurant, name: 'Tandoori Nights', isOpen: false, status: 'active' },
      items: [{ id: oid(), name: 'Galouti Kebab', price: 44900, isVeg: false, isAvailable: true }],
    });
    this.menus.set(ids.otherRestaurant, {
      restaurant: { id: ids.otherRestaurant, name: 'Dragon Wok', isOpen: true, status: 'active' },
      items: [{ id: ids.otherItem, name: 'Chilli Chicken', price: 29900, isVeg: false, isAvailable: true }],
    });
    this.restaurants.set(ids.restaurant, { id: ids.restaurant, name: 'Spice Route Biryani House', adminIds: [OWNER_ID] });
    this.restaurants.set(ids.otherRestaurant, { id: ids.otherRestaurant, name: 'Dragon Wok', adminIds: [] });
  }

  async getMenu(restaurantId: string) {
    if (this.down) throw new ServiceUnavailableError('Upstream service is unreachable: catalog', 'CATALOG_UNAVAILABLE');
    return structuredClone(this.menus.get(restaurantId) ?? null);
  }

  async getRestaurant(restaurantId: string) {
    return this.restaurants.get(restaurantId) ?? null;
  }
}

/** Records published events; can be told to fail to simulate a broker outage. */
export class FakePublisher implements EventPublisher {
  published: EventEnvelope[] = [];
  connected = true;
  failNext = 0;

  isConnected() {
    return this.connected;
  }

  async publish(event: EventEnvelope) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable');
    }
    this.published.push(event);
  }
}

export const address = { line1: '221B, 5th Cross, Indiranagar', city: 'Bengaluru', pincode: '560038' };

/** Builds a contract-valid payment.* envelope for an order (as the Payment Service would publish). */
export function paymentEvent(
  type: 'payment.succeeded' | 'payment.failed' | 'payment.cancelled' | 'payment.refund.completed' | 'payment.refund.failed',
  order: { id: string; customerId: string; provisionalTotal: number },
  overrides: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  const base = { paymentId: 'pay_test_1', orderId: order.id, customerId: order.customerId, amount: order.provisionalTotal };
  const data = {
    'payment.succeeded': { ...base, currency: 'INR', provider: 'mock', providerReference: 'pi_mock_1', paidAt: now },
    'payment.failed': { ...base, reason: 'Your card was declined.', failureCode: 'card_declined', retryable: true, failedAt: now },
    'payment.cancelled': { ...base, reason: 'order cancelled', cancelledAt: now },
    'payment.refund.completed': { ...base, refundId: 'ref_test_1', totalRefunded: order.provisionalTotal, fullyRefunded: true, providerReference: 're_mock_1', refundedAt: now },
    'payment.refund.failed': { ...base, refundId: 'ref_test_1', reason: 'expired_or_canceled_card', failedAt: now },
  }[type];
  return createEnvelope({ eventType: type, version: 1, source: 'payment-service', data: { ...data, ...overrides } });
}

/** billing.invoice_generated.v1 for an order (as the Billing Service would publish). */
export function invoiceEvent(
  order: { id: string; customerId: string; provisionalTotal: number; orderNumber?: string },
  overrides: Record<string, unknown> = {},
) {
  const discountAmount = (overrides.discountAmount as number | undefined) ?? 0;
  const { eventType = 'billing.invoice_generated', ...rest } = overrides as { eventType?: string } & Record<string, unknown>;
  overrides = rest;
  return createEnvelope({
    eventType,
    version: 1,
    source: 'billing-service',
    data: {
      invoiceId: 'inv_test_1',
      invoiceNumber: 'INV-TEST-000001',
      orderId: order.id,
      orderNumber: order.orderNumber ?? 'ORD-TEST',
      customerId: order.customerId,
      currency: 'INR',
      itemsSubtotal: order.provisionalTotal,
      deliveryFee: 0,
      subtotal: order.provisionalTotal,
      discountAmount,
      taxAmount: 0,
      finalAmount: order.provisionalTotal - discountAmount,
      issuedAt: new Date().toISOString(),
      ...overrides,
    },
  });
}

/** A delivery.* fact (as the future Delivery Service would publish). */
export function deliveryEvent(
  type: 'delivery.ready_for_pickup' | 'delivery.partner_assigned' | 'delivery.picked_up' | 'delivery.location_reached' | 'delivery.completed',
  orderId: string,
  extra: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  const base = { deliveryId: 'del_test_1', orderId };
  const data = {
    'delivery.ready_for_pickup': { ...base, restaurantId: 'r1', readyAt: now },
    'delivery.partner_assigned': { ...base, agentId: 'agent_1', agentName: 'Ravi K.', assignedAt: now },
    'delivery.picked_up': { ...base, agentId: 'agent_1', pickedUpAt: now },
    'delivery.location_reached': { ...base, agentId: 'agent_1', reachedAt: now, otpExpiresAt: now },
    'delivery.completed': { ...base, agentId: 'agent_1', deliveredAt: now, otpVerified: true },
  }[type];
  return createEnvelope({ eventType: type, version: 1, source: 'delivery-service', data: { ...data, ...extra } });
}

export const DELIVERY_STEPS = ['delivery.ready_for_pickup', 'delivery.partner_assigned', 'delivery.picked_up', 'delivery.location_reached', 'delivery.completed'] as const;
