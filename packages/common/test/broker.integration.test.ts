/**
 * Runs against a real RabbitMQ. Skipped unless RABBITMQ_TEST_URL is set, e.g.
 *   RABBITMQ_TEST_URL=amqp://food:food-dev-password@localhost:5672 npm test -w @food/common
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvelope, createLogger, MessageBroker, PermanentEventError, processOnce, type EventEnvelope } from '../src/index.js';

const url = process.env.RABBITMQ_TEST_URL;
const logger = createLogger('broker-test', 'silent');

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function managementApi(path: string, method = 'GET') {
  const u = new URL(url!);
  const res = await fetch(`http://${u.hostname}:15672/api${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` },
  });
  return (method === 'GET' ? res.json() : {}) as Promise<{ messages?: number }>;
}

describe.skipIf(!url)('MessageBroker (real RabbitMQ)', () => {
  const exchange = `test.events.${randomUUID().slice(0, 8)}`;
  const broker = new MessageBroker({ url: url!, exchange, logger });
  let replSet: MongoMemoryReplSet;

  beforeAll(async () => {
    await broker.connect();
    await broker.waitForConnect();
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri('broker_test'));
  });

  afterAll(async () => {
    await broker.close();
    // Remove the durable test topology so repeated runs leave the broker clean.
    for (const name of ['basic', 'flaky', 'idempotent', 'permanent', 'restart']) {
      for (const suffix of ['', '.retry', '.dlq']) {
        await managementApi(`/queues/%2F/${encodeURIComponent(`${exchange}.${name}${suffix}`)}`, 'DELETE');
      }
      await managementApi(`/exchanges/%2F/${encodeURIComponent(`${exchange}.${name}.parking`)}`, 'DELETE');
    }
    await managementApi(`/exchanges/%2F/${encodeURIComponent(exchange)}`, 'DELETE');
    await mongoose.disconnect();
    await replSet?.stop();
  });

  const event = (data: unknown) => createEnvelope({ eventType: 'test.happened', version: 1, source: 'test', data });

  it('delivers published events to bound consumers', async () => {
    const received: EventEnvelope[] = [];
    await broker.subscribe({
      queue: `${exchange}.basic`,
      routingKeys: ['test.happened.v1'],
      handler: async (e) => {
        received.push(e);
      },
    });
    const sent = event({ n: 1 });
    await broker.publish(sent);
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(sent);
  });

  it('retries failed handlers, then dead-letters after maxRetries', async () => {
    let attempts = 0;
    const queue = `${exchange}.flaky`;
    await broker.subscribe({
      queue,
      routingKeys: ['test.happened.v1'],
      maxRetries: 2,
      retryDelayMs: 100,
      handler: async () => {
        attempts++;
        throw new Error('handler always fails');
      },
    });
    await broker.publish(event({ n: 2 }));
    await waitFor(() => attempts === 3); // initial + 2 retries
    await waitFor(async () => (await managementApi(`/queues/%2F/${encodeURIComponent(`${queue}.dlq`)}`)).messages === 1, 15_000);
    expect(attempts).toBe(3);
  });

  it('dead-letters PermanentEventError immediately without retries', async () => {
    let attempts = 0;
    const queue = `${exchange}.permanent`;
    await broker.subscribe({
      queue,
      routingKeys: ['test.happened.v1'],
      maxRetries: 5,
      retryDelayMs: 100,
      handler: async () => {
        attempts++;
        throw new PermanentEventError('payload violates contract');
      },
    });
    await broker.publish(event({ n: 4 }));
    await waitFor(async () => (await managementApi(`/queues/%2F/${encodeURIComponent(`${queue}.dlq`)}`)).messages === 1, 15_000);
    await new Promise((r) => setTimeout(r, 400)); // longer than retryDelayMs: a retry would have happened by now
    expect(attempts).toBe(1);
  });

  it('keeps events in the durable queue while the consumer is down (consumer restart)', async () => {
    const queue = `${exchange}.restart`;
    const first = new MessageBroker({ url: url!, exchange, logger });
    await first.connect();
    const received: string[] = [];
    await first.subscribe({ queue, routingKeys: ['test.happened.v1'], handler: async (e) => void received.push(e.eventId) });
    await first.close(); // consumer goes away; queue + binding are durable

    const whileDown = event({ n: 5 });
    await broker.publish(whileDown);
    await waitFor(async () => (await managementApi(`/queues/%2F/${encodeURIComponent(queue)}`)).messages === 1);

    const second = new MessageBroker({ url: url!, exchange, logger });
    await second.connect();
    await second.subscribe({ queue, routingKeys: ['test.happened.v1'], handler: async (e) => void received.push(e.eventId) });
    await waitFor(() => received.includes(whileDown.eventId));
    await second.close();
  });

  it('applies duplicate deliveries only once with processOnce', async () => {
    const Counter = mongoose.model('Counter', new mongoose.Schema({ _id: String, n: Number }));
    await Counter.create({ _id: 'c', n: 0 });
    const queue = `${exchange}.idempotent`;
    const outcomes: boolean[] = [];
    await broker.subscribe({
      queue,
      routingKeys: ['test.happened.v1'],
      retryDelayMs: 100,
      handler: async (e) => {
        const applied = await processOnce('counter-consumer', e.eventId, async (session) => {
          await Counter.updateOne({ _id: 'c' }, { $inc: { n: 1 } }, { session });
        });
        outcomes.push(applied);
      },
    });
    const dup = event({ n: 3 });
    await broker.publish(dup);
    await broker.publish(dup); // simulated redelivery: same eventId, possibly processed concurrently
    await waitFor(() => outcomes.length === 2);
    expect(outcomes.sort()).toEqual([false, true]);
    expect((await Counter.findById('c').lean())!.n).toBe(1);
  });

  it('refuses to publish restricted commands on the general exchange', async () => {
    const evt = createEnvelope({ eventType: 'notification.delivery_otp', version: 1, source: 'delivery-service', data: {} });
    await expect(broker.publish(evt)).rejects.toThrow(/restricted exchange/);
  });
});
