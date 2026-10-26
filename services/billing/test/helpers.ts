import { Types } from 'mongoose';
import { createEnvelope, createLogger, signAccessToken, type Role } from '@food/common';
import { createApp } from '../src/app.js';
import { loadBillingConfig } from '../src/config.js';
import { BillingService } from '../src/services/billing.service.js';
import type { BillableOrder } from '../src/services/calculator.js';

export const config = loadBillingConfig({
  NODE_ENV: 'test', MONGO_URI: 'unused', JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long', RABBITMQ_URL: 'amqp://unused', ORDER_SERVICE_URL: 'http://order.invalid',
});
export const oid = () => new Types.ObjectId().toString();
export function userToken(role: Role, id = oid()) {
  const token = signAccessToken({ id, role, email: `${role}@t.local`, name: role }, { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: '5m' });
  return { id, token, header: { authorization: `Bearer ${token}` } };
}

export function harness() {
  const billing = new BillingService(createLogger('billing-test', 'silent'), { minPayable: config.MIN_PAYABLE_AMOUNT });
  const app = createApp(config, createLogger('billing-test', 'silent'), { billing });
  return {
    billing,
    app,
    customer() {
      return userToken('customer');
    },
  };
}

export function billable(customerId: string, o: Partial<BillableOrder> = {}): BillableOrder {
  return {
    orderId: oid(), orderNumber: `ORD-${Math.floor(Math.random() * 1e6)}`, customerId, restaurantId: oid(), restaurantName: 'Spice Route Biryani House',
    items: [
      { menuItemId: oid(), name: 'Chicken Dum Biryani', unitPrice: 32900, quantity: 2, lineTotal: 65800 },
      { menuItemId: oid(), name: 'Raita', unitPrice: 4900, quantity: 1, lineTotal: 4900 },
    ],
    subtotal: 70700, deliveryFee: 0, provisionalTotal: 70700, ...o,
  };
}

const env = (eventType: string, data: object) => createEnvelope({ eventType, version: 1, source: 'test', data });
const now = () => new Date().toISOString();

export const events = {
  orderCreated: (o: BillableOrder) => env('order.created', {
    orderId: o.orderId, orderNumber: o.orderNumber, customerId: o.customerId, customerEmail: 'c@t.local', restaurantId: o.restaurantId, restaurantName: o.restaurantName,
    items: o.items, subtotal: o.subtotal, deliveryFee: o.deliveryFee, provisionalTotal: o.provisionalTotal, currency: 'INR',
    deliveryAddress: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' }, createdAt: now(), expiresAt: new Date(Date.now() + 900_000).toISOString(), ...(o.discountCode ? { discountCode: o.discountCode } : {}),
  }),
  orderCancelled: (o: BillableOrder) => env('order.cancelled', { orderId: o.orderId, orderNumber: o.orderNumber, customerId: o.customerId, restaurantId: o.restaurantId, reason: 'changed mind', cancelledBy: 'customer', previousStatus: 'pending_payment', paymentStatus: 'pending', provisionalTotal: o.provisionalTotal, cancelledAt: now() }),
  orderExpired: (o: BillableOrder) => env('order.expired', { orderId: o.orderId, orderNumber: o.orderNumber, customerId: o.customerId, restaurantId: o.restaurantId, paymentStatus: 'pending', provisionalTotal: o.provisionalTotal, expiresAt: now(), expiredAt: now() }),
  paymentSucceeded: (o: BillableOrder, amount: number, paymentId = 'pay_1') => env('payment.succeeded', { paymentId, orderId: o.orderId, customerId: o.customerId, amount, currency: 'INR', provider: 'mock', providerReference: 'pi_mock_1', paidAt: now() }),
  refundCompleted: (o: BillableOrder, amount: number, total: number, full: boolean, refundId = 'ref_1') => env('payment.refund.completed', { refundId, paymentId: 'pay_1', orderId: o.orderId, customerId: o.customerId, amount, totalRefunded: total, fullyRefunded: full, providerReference: 're_mock_1', refundedAt: now() }),
  refundFailed: (o: BillableOrder, amount: number, refundId = 'ref_1') => env('payment.refund.failed', { refundId, paymentId: 'pay_1', orderId: o.orderId, customerId: o.customerId, amount, reason: 'expired_or_canceled_card', failedAt: now() }),
};
