/**
 * Notification Service against a real RabbitMQ and SMTP server (Mailpit).
 * Skipped unless RABBITMQ_TEST_URL is set; the SMTP part also needs MAILPIT_URL (e.g. http://localhost:8025).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, MessageBroker } from '@food/common';
import { subscribeOrderEvents } from '../src/consumers/order-events.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { SmtpMailer } from '../src/services/mailer.js';
import { Sender } from '../src/services/notifier.js';
import { FakeMailer, oid, statusChanged } from './helpers.js';
import { useTestDatabase } from './setup.js';

const url = process.env.RABBITMQ_TEST_URL;
const mailpit = process.env.MAILPIT_URL;
const logger = createLogger('notification-mq-test', 'silent');

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!url)('notification-service ↔ RabbitMQ (real broker)', () => {
  useTestDatabase();
  const exchange = `test.notifications.${randomUUID().slice(0, 8)}`;
  const queue = `${exchange}.order-events`;
  const broker = new MessageBroker({ url: url!, exchange, logger });
  const mailer = new FakeMailer();
  const sender = new Sender(mailer, logger, { intervalMs: 60_000, leaseMs: 60_000, appName: 'FoodApp' });
  let active = sender; // the sender woken when the consumer queues a notification

  beforeAll(async () => {
    await broker.connect();
    await broker.waitForConnect();
    await subscribeOrderEvents(broker, logger, { maxAttempts: 3, onQueued: () => active.kick() }, queue);
  });

  afterAll(async () => {
    await sender.stop();
    await broker.close();
    const u = new URL(url!);
    const auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
    // Only this run's uniquely named queues/exchange — never the real service ones.
    await fetch(`http://${u.hostname}:15672/api/exchanges/%2F/${encodeURIComponent(`${queue}.parking`)}`, { method: 'DELETE', headers: { authorization: auth } }).catch(() => undefined);
    for (const q of [queue, `${queue}.retry`, `${queue}.dlq`]) {
      await fetch(`http://${u.hostname}:15672/api/queues/%2F/${encodeURIComponent(q)}`, { method: 'DELETE', headers: { authorization: auth } }).catch(() => undefined);
    }
    await fetch(`http://${u.hostname}:15672/api/exchanges/%2F/${encodeURIComponent(exchange)}`, { method: 'DELETE', headers: { authorization: auth } }).catch(() => undefined);
  });

  it('routes order.status_changed.v1 to exactly one email, despite duplicate delivery', async () => {
    const orderId = oid();
    const evt = statusChanged(orderId, 'confirmed');
    await broker.publish(evt);
    await broker.publish(evt);
    await waitFor(async () => mailer.sent.find((e) => e.headers?.['X-Order-Id'] === orderId));
    await new Promise((r) => setTimeout(r, 500));
    expect(mailer.sent.filter((e) => e.headers?.['X-Order-Id'] === orderId)).toHaveLength(1);
  });

  it('dead-letters malformed events without creating notifications', async () => {
    const bad = statusChanged(oid(), 'confirmed');
    delete (bad.data as Record<string, unknown>).summary;
    await broker.publish(bad);
    const u = new URL(url!);
    const auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
    await waitFor(async () => {
      const r = await fetch(`http://${u.hostname}:15672/api/queues/%2F/${encodeURIComponent(`${queue}.dlq`)}`, { headers: { authorization: auth } });
      return r.ok && ((await r.json()) as { messages?: number }).messages! >= 1;
    }, 20_000);
    expect(await NotificationModel.countDocuments({ orderId: (bad.data as { orderId: string }).orderId })).toBe(0);
  });

  it.skipIf(!mailpit)('delivers a rendered email through real SMTP into Mailpit', async () => {
    const smtp = new SmtpMailer({ host: new URL(mailpit!).hostname, port: 1025, secure: false, timeoutMs: 5000 }, 'FoodApp <no-reply@food.local>');
    const smtpSender = new Sender(smtp, logger, { intervalMs: 60_000, leaseMs: 60_000, appName: 'FoodApp' });
    const recipient = `it-${randomUUID().slice(0, 8)}@example.com`;
    const orderId = oid();
    active = smtpSender;
    await broker.publish(statusChanged(orderId, 'delivered', { previousStatus: 'location_reached', email: recipient }));
    const n = await waitFor(async () => (await NotificationModel.findOne({ orderId, status: 'sent' }).lean()) ?? null);
    expect(n.smtpResponse).toMatch(/^250/);
    const found = await waitFor(async () => {
      const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`);
      const body = (await r.json()) as { messages: { Subject: string }[] };
      return body.messages.length ? body.messages : null;
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.Subject).toMatch(/delivered/i);
  });
});
