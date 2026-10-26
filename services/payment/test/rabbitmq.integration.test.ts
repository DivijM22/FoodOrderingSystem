/**
 * Payment Service messaging against a real RabbitMQ (skipped unless RABBITMQ_TEST_URL is set).
 * Exercises: durable consumer, duplicate delivery, outbox → broker publication.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, MessageBroker, OutboxRelay, type EventEnvelope } from '@food/common';
import { subscribeOrderEvents } from '../src/consumers/order-events.js';
import { PaymentModel } from '../src/models/payment.model.js';
import { createHarness, oid, orderCancelled, orderCreated } from './helpers.js';
import { useTestDatabase } from './setup.js';

const url = process.env.RABBITMQ_TEST_URL;
const logger = createLogger('payment-mq-test', 'silent');

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!url)('payment-service ↔ RabbitMQ (real broker)', () => {
  useTestDatabase();
  const exchange = `test.payments.${randomUUID().slice(0, 8)}`;
  const broker = new MessageBroker({ url: url!, exchange, logger });
  const h = createHarness();
  const relay = new OutboxRelay(broker, logger, { pollIntervalMs: 50 });
  const received: EventEnvelope[] = [];
  const queue = `${exchange}.inspect`;

  beforeAll(async () => {
    await broker.connect();
    await broker.waitForConnect();
    await subscribeOrderEvents(broker, h.workflow, logger, `${exchange}.order-events`);
    await broker.subscribe({ queue, routingKeys: ['payment.#'], handler: async (e) => void received.push(e) });
    relay.start();
  });

  afterAll(async () => {
    await relay.stop();
    await broker.close();
    const u = new URL(url!);
    const auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
    for (const base of [`${exchange}.order-events`, queue]) {
      await fetch(`http://${u.hostname}:15672/api/exchanges/%2F/${encodeURIComponent(`${base}.parking`)}`, { method: 'DELETE', headers: { authorization: auth } }).catch(() => undefined);
    }
    for (const base of [`${exchange}.order-events`, queue]) for (const q of [base, `${base}.retry`, `${base}.dlq`]) {
      // Only this run's uniquely named queues — never the real service queues.
      await fetch(`http://${u.hostname}:15672/api/queues/%2F/${encodeURIComponent(q)}`, { method: 'DELETE', headers: { authorization: auth } }).catch(() => undefined);
    }
    await fetch(`http://${u.hostname}:15672/api/exchanges/%2F/${encodeURIComponent(exchange)}`, { method: 'DELETE', headers: { authorization: auth } }).catch(() => undefined);
  });

  it('consumes order.created (duplicates included) into exactly one payment record', async () => {
    const o = h.newOrder(oid());
    const created = orderCreated(o);
    await broker.publish(created);
    await broker.publish(created); // redelivery with the same eventId
    await waitFor(() => PaymentModel.findOne({ orderId: o.id }).lean());
    await new Promise((r) => setTimeout(r, 500));
    expect(await PaymentModel.countDocuments({ orderId: o.id })).toBe(1);
  });

  it('consumes order.cancelled and publishes payment.cancelled through the outbox', async () => {
    const o = h.newOrder(oid());
    await broker.publish(orderCreated(o));
    await waitFor(() => PaymentModel.findOne({ orderId: o.id }).lean());
    await broker.publish(orderCancelled(o));
    const evt = await waitFor(async () => received.find((e) => e.eventType === 'payment.cancelled' && (e.data as { orderId: string }).orderId === o.id));
    expect(evt).toMatchObject({ source: 'payment-service', version: 1 });
    expect((await PaymentModel.findOne({ orderId: o.id }).lean())!.status).toBe('cancelled');
  });
});
