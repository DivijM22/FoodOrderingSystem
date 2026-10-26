import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createLogger, enqueueEvent, EventTypes, OutboxModel, OutboxRelay, RESTRICTED_EXCHANGE, type EventEnvelope, type EventPublisher } from '../src/index.js';
import { useTestDatabase } from './setup.js';

/** Records published events; can be told to fail to simulate a broker outage. */
class FakePublisher implements EventPublisher {
  published: EventEnvelope[] = [];
  connected = true;
  failNext = 0;
  isConnected() {
    return this.connected;
  }
  exchanges: (string | undefined)[] = [];
  async publish(event: EventEnvelope, opts?: { exchange?: string }) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable');
    }
    this.published.push(event);
    this.exchanges.push(opts?.exchange);
  }
}

useTestDatabase();
const logger = createLogger('relay-test', 'silent');

async function enqueueCancelled(orderId: string) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() =>
      enqueueEvent(session, {
        source: 'test-service',
        eventType: EventTypes.OrderCancelled,
        aggregateId: orderId,
        data: {
          orderId, orderNumber: `ORD-${orderId}`, customerId: 'c1', restaurantId: 'r1', reason: 'test',
          cancelledBy: 'customer', previousStatus: 'pending_payment', paymentStatus: 'pending',
          provisionalTotal: 1000, cancelledAt: new Date().toISOString(),
        },
      }),
    );
  } finally {
    await session.endSession();
  }
}

describe('transactional outbox', () => {
  it('publishes in creation order and marks events published', async () => {
    const publisher = new FakePublisher();
    for (const id of ['o1', 'o2', 'o3']) await enqueueCancelled(id);
    await new OutboxRelay(publisher, logger).drain();
    expect(publisher.published.map((e) => (e.data as { orderId: string }).orderId)).toEqual(['o1', 'o2', 'o3']);
    expect(await OutboxModel.countDocuments({ status: 'published' })).toBe(3);
  });

  it('keeps events pending through a broker outage and recovers without loss', async () => {
    const publisher = new FakePublisher();
    const relay = new OutboxRelay(publisher, logger, { pollIntervalMs: 1, maxBackoffMs: 5 });
    await enqueueCancelled('o1');
    await enqueueCancelled('o2');

    publisher.failNext = 2;
    await relay.drain();
    expect(publisher.published).toHaveLength(0);
    const first = await OutboxModel.findOne({ aggregateId: 'o1' }).lean();
    expect(first).toMatchObject({ status: 'pending', attempts: 1, lastError: 'broker unavailable' });
    // o2 was not attempted, preserving order.
    expect((await OutboxModel.findOne({ aggregateId: 'o2' }).lean())!.attempts).toBe(0);

    await new Promise((r) => setTimeout(r, 10));
    await relay.drain(); // fails again (second injected failure)
    await new Promise((r) => setTimeout(r, 10));
    await relay.drain();
    expect(publisher.published.map((e) => (e.data as { orderId: string }).orderId)).toEqual(['o1', 'o2']);
    expect(await relay.pendingCount()).toBe(0);
  });

  it('does nothing while the broker is disconnected', async () => {
    const publisher = new FakePublisher();
    publisher.connected = false;
    await enqueueCancelled('o1');
    await new OutboxRelay(publisher, logger).drain();
    expect((await OutboxModel.findOne().lean())!.attempts).toBe(0);
  });

  it('rejects events that violate their contract before they reach the outbox', async () => {
    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(() =>
        // @ts-expect-error — deliberately invalid payload
        enqueueEvent(session, { source: 'test-service', eventType: EventTypes.OrderCancelled, aggregateId: 'x', data: { orderId: 'x' } }),
      ),
    ).rejects.toThrow();
    await session.endSession();
    expect(await OutboxModel.countDocuments()).toBe(0);
  });

  it('collapses concurrent drains into one run (no double publish)', async () => {
    const publisher = new FakePublisher();
    const relay = new OutboxRelay(publisher, logger);
    await enqueueCancelled('o1');
    await Promise.all([relay.drain(), relay.drain(), relay.drain()]);
    expect(publisher.published).toHaveLength(1);
  });

  it('stamps aggregateId and a default correlationId on the envelope', async () => {
    await enqueueCancelled('o-agg');
    const pub = new FakePublisher();
    await new OutboxRelay(pub, logger).drain();
    expect(pub.published[0]).toMatchObject({ aggregateId: 'o-agg', correlationId: 'o-agg' });
    expect(pub.exchanges[0]).toBeUndefined();
  });

  it('routes restricted commands to the restricted exchange only', async () => {
    const session = await mongoose.startSession();
    await session.withTransaction(() =>
      enqueueEvent(session, {
        source: 'delivery-service',
        eventType: EventTypes.DeliveryOtpNotification,
        aggregateId: 'o-otp',
        data: {
          deliveryId: 'd1', orderId: 'o-otp', orderNumber: 'ORD-1', customerId: 'c1', customerEmail: 'a@example.com',
          customerName: 'A', agentName: 'Ravi', otpSequence: 1, otpCiphertext: 'v1.a.b.c.d', otpExpiresAt: new Date().toISOString(),
        },
      }),
    );
    await session.endSession();
    const pub = new FakePublisher();
    await new OutboxRelay(pub, logger).drain();
    expect(pub.exchanges).toEqual([RESTRICTED_EXCHANGE]);
  });
});
