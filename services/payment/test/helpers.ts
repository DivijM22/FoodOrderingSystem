import request from 'supertest';
import { Types } from 'mongoose';
import { createEnvelope, createLogger, OutboxModel, signAccessToken, type Role } from '@food/common';
import { createApp } from '../src/app.js';

import { loadPaymentConfig } from '../src/config.js';
import { MockPaymentProvider } from '../src/providers/mock.provider.js';
import { PaymentWorkflow, type InvoiceRef } from '../src/services/workflow.js';

/** Minimal order data the tests deal in (what order.created / billing.finalized carry). */
export interface OrderView {
  id: string;
  orderNumber: string;
  customerId: string;
  status: string;
  paymentStatus: string;
  provisionalTotal: number;
  currency: 'INR';
  expiresAt?: string | null;
}

export const WEBHOOK_SECRET = 'whsec_test_secret_for_automated_tests';

export const config = loadPaymentConfig({
  NODE_ENV: 'test',
  MONGO_URI: 'unused-in-tests',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  RABBITMQ_URL: 'amqp://unused',
  ORDER_SERVICE_URL: 'http://order.invalid',
  PAYMENT_PROVIDER: 'mock',
  MOCK_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ENABLE_TEST_ENDPOINTS: 'true',
});

export const oid = () => new Types.ObjectId().toString();

export function userToken(role: Role, id = oid()) {
  const token = signAccessToken(
    { id, role, email: `${role}@test.local`, name: role },
    { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: '5m' },
  );
  return { id, header: { authorization: `Bearer ${token}` } };
}

/** Registry of test orders and the invoices "Billing" issued for them (finalAmount = total − discount). */
export class FakeBilling {
  invoices = new Map<string, InvoiceRef>();
  invoiceFor(o: OrderView, discount = 0): InvoiceRef {
    let inv = this.invoices.get(o.id);
    if (!inv) {
      inv = {
        invoiceId: oid(),
        invoiceNumber: `INV-TEST-${o.id.slice(-6)}`,
        orderId: o.id,
        orderNumber: o.orderNumber,
        customerId: o.customerId,
        finalAmount: o.provisionalTotal - discount,
        ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
      };
      this.invoices.set(o.id, inv);
    }
    return inv;
  }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  workflow: PaymentWorkflow;
  mock: MockPaymentProvider;
  orders: { orders: Map<string, OrderView> };
  billing: FakeBilling;
  /** Delivers billing.finalized for an order (optionally discounted), as the Billing Service would publish it. */
  bill(o: OrderView, discount?: number): Promise<InvoiceRef>;
  /** order.created + billing.finalized: the order becomes payable. */
  ready(o: OrderView, discount?: number): Promise<InvoiceRef>;
  /** Webhooks the mock sent (payload + signature), in order. */
  sent: { payload: string; signature: string; type: string }[];
  /** When false, mock webhooks are recorded but NOT delivered (simulates lost/late webhooks). */
  autoDeliver: { on: boolean };
  /** Lets mock webhooks land, then runs the reconciler, until things settle. */
  drive(): Promise<void>;
  deliver(w: { payload: string; signature: string }): Promise<request.Response>;
  customer(id?: string): { id: string; header: { authorization: string } };
  newOrder(customerId: string, overrides?: Partial<OrderView>): OrderView;
}

export function createHarness(): Harness {
  const logger = createLogger('payment-test', 'silent');
  const sent: Harness['sent'] = [];
  const autoDeliver = { on: true };
  let app!: ReturnType<typeof createApp>;
  const deliver = (w: { payload: string; signature: string }) =>
    request(app).post('/payments/webhook').set('content-type', 'application/json').set('stripe-signature', w.signature).send(w.payload);
  const mock = new MockPaymentProvider(
    WEBHOOK_SECRET,
    async (payload, signature) => {
      sent.push({ payload, signature, type: JSON.parse(payload).type });
      if (autoDeliver.on) {
        const res = await deliver({ payload, signature });
        if (res.status >= 300) throw new Error(`webhook ${res.status}: ${JSON.stringify(res.body)}`);
      }
    },
    logger,
    5,
  );
  const workflow = new PaymentWorkflow(mock, logger, () => undefined, { pollAfterMs: 0 });
  const orders = { orders: new Map<string, OrderView>() };
  const billing = new FakeBilling();
  app = createApp(config, logger, { workflow });

  return {
    app,
    workflow,
    mock,
    orders,
    billing,
    async bill(o, discount) {
      const inv = billing.invoiceFor(o, discount);
      const { handleBillingEvent } = await import('../src/consumers/order-events.js');
      await handleBillingEvent(workflow, billingFinalized(inv));
      return inv;
    },
    async ready(o, discount) {
      const { handleOrderEvent } = await import('../src/consumers/order-events.js');
      await handleOrderEvent(workflow, orderCreated(o));
      return this.bill(o, discount);
    },
    sent,
    autoDeliver,
    deliver,
    async drive() {
      for (let i = 0; i < 4; i++) {
        await mock.settle();
        await workflow.reconcile();
      }
      await mock.settle();
    },
    customer(id = oid()) {
      return userToken('customer', id);
    },
    newOrder(customerId, overrides = {}) {
      const id = oid();
      const o: OrderView = {
        id,
        orderNumber: `ORD-TEST-${id.slice(-6).toUpperCase()}`,
        customerId,
        status: 'pending_payment',
        paymentStatus: 'pending',
        provisionalTotal: 70700,
        currency: 'INR',
        ...overrides,
      };
      orders.orders.set(id, o);
      return o;
    },
  };
}

export function orderCreated(o: OrderView) {
  return createEnvelope({
    eventType: 'order.created',
    version: 1,
    source: 'order-service',
    data: {
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerId: o.customerId,
      customerEmail: 'c@test.local',
      restaurantId: oid(),
      restaurantName: 'Spice Route Biryani House',
      items: [{ menuItemId: oid(), name: 'Chicken Dum Biryani', unitPrice: 32900, quantity: 2, lineTotal: 65800 }],
      subtotal: o.provisionalTotal,
      deliveryFee: 0,
      provisionalTotal: o.provisionalTotal,
      currency: 'INR',
      deliveryAddress: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' },
      createdAt: new Date().toISOString(),
      ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
    },
  });
}

export function orderCancelled(o: OrderView, overrides: Record<string, unknown> = {}) {
  return createEnvelope({
    eventType: 'order.cancelled',
    version: 1,
    source: 'order-service',
    data: {
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerId: o.customerId,
      restaurantId: oid(),
      reason: 'Changed my mind',
      cancelledBy: 'customer',
      previousStatus: 'pending_payment',
      paymentStatus: 'pending',
      provisionalTotal: o.provisionalTotal,
      cancelledAt: new Date().toISOString(),
      ...overrides,
    },
  });
}

/** Payment events written to the outbox (what will be published), in order. */
export async function outboxTypes(orderId?: string) {
  const events = await OutboxModel.find(orderId ? { aggregateId: orderId } : {}).sort({ createdAt: 1 }).lean();
  return events.map((e) => e.eventType);
}

export function orderExpired(o: OrderView) {
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  return createEnvelope({
    eventType: 'order.expired',
    version: 1,
    source: 'order-service',
    data: {
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerId: o.customerId,
      restaurantId: oid(),
      paymentStatus: 'pending',
      provisionalTotal: o.provisionalTotal,
      expiresAt,
      expiredAt: new Date().toISOString(),
    },
  });
}

export function billingFinalized(inv: InvoiceRef, eventType: 'billing.finalized' | 'billing.invoice_generated' = 'billing.finalized') {
  return createEnvelope({
    eventType,
    version: 1,
    source: 'billing-service',
    data: {
      invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, orderId: inv.orderId, orderNumber: inv.orderNumber, customerId: inv.customerId,
      currency: 'INR', itemsSubtotal: inv.finalAmount, deliveryFee: 0, subtotal: inv.finalAmount, discountAmount: 0, taxAmount: 0, finalAmount: inv.finalAmount,
      ...(eventType === 'billing.finalized' ? { invoiceVersion: 1, ...(inv.expiresAt ? { expiresAt: inv.expiresAt } : {}) } : {}),
      issuedAt: new Date().toISOString(),
    },
  });
}
