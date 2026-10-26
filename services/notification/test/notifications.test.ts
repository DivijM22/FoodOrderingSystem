import { describe, expect, it } from 'vitest';
import { createEnvelope, createLogger, EventTypes, PermanentEventError } from '@food/common';
import { NotificationModel } from '../src/models/notification.model.js';
import { PermanentMailError } from '../src/services/mailer.js';
import { handleOrderEvent, Sender } from '../src/services/notifier.js';
import { render, TEMPLATE_FOR_STATUS, type TemplateName } from '../src/templates/index.js';
import { FakeMailer, oid, statusChanged } from './helpers.js';
import { useTestDatabase } from './setup.js';

const logger = createLogger('notification-test', 'silent');
const opts = { maxAttempts: 3 };
const senderOpts = { intervalMs: 60_000, leaseMs: 60_000, appName: 'FoodApp' };

describe('templates', () => {
  it('maps every customer-facing status to a template and pending_payment to none', () => {
    expect(TEMPLATE_FOR_STATUS).toMatchObject({
      confirmed: 'ORDER_CONFIRMED',
      cancelled: 'ORDER_CANCELLED',
      expired: 'ORDER_EXPIRED',
      assigning_delivery_partner: 'DELIVERY_ASSIGNING',
      partner_assigned: 'DELIVERY_PARTNER_ASSIGNED',
      out_for_delivery: 'OUT_FOR_DELIVERY',
      location_reached: 'AGENT_ARRIVED',
      delivered: 'ORDER_DELIVERED',
    });
    expect(TEMPLATE_FOR_STATUS.pending_payment).toBeUndefined();
  });

  it('renders HTML and text for every template, escaping user-supplied values', () => {
    for (const template of new Set(Object.values(TEMPLATE_FOR_STATUS)) as Set<TemplateName>) {
      const ctx = { ...(statusChanged(oid(), 'confirmed').data as object), orderNumber: 'ORD-1', reason: '<b>changed mind</b>' } as never;
      const email = render(template, ctx, 'FoodApp');
      expect(email.subject).toContain('ORD-1');
      expect(email.text.length).toBeGreaterThan(20);
      expect(email.html).toContain('<html');
      expect(email.html).not.toContain('<Rao>');
      expect(email.html).not.toContain('<b>changed mind</b>');
    }
  });

  it('confirmation email states the amount paid in rupees and lists items', () => {
    const ctx = statusChanged(oid(), 'confirmed').data as never;
    const email = render('ORDER_CONFIRMED', ctx, 'FoodApp');
    expect(email.text).toContain('₹673.00');
    expect(email.text).toContain('Paneer Tikka');
    expect(email.html).toContain('Spice &amp; Co');
  });
});

describe('handleOrderEvent', () => {
  useTestDatabase();

  it('queues one notification record per supported transition', async () => {
    const orderId = oid();
    const evt = statusChanged(orderId, 'confirmed');
    expect(await handleOrderEvent(evt, opts)).toBe('queued');
    const n = (await NotificationModel.findOne({ orderId }).lean())!;
    expect(n).toMatchObject({
      sourceEventId: evt.eventId,
      recipient: 'asha@example.com',
      template: 'ORDER_CONFIRMED',
      status: 'pending',
      attempts: 0,
      dedupeKey: `order:${orderId}:status:confirmed`,
    });
  });

  it('ignores other order events (no double email for order.confirmed + status_changed)', async () => {
    const evt = createEnvelope({ eventType: EventTypes.OrderConfirmed, version: 1, source: 'order-service', data: { orderId: oid() } });
    expect(await handleOrderEvent(evt, opts)).toBe('ignored');
    expect(await NotificationModel.countDocuments()).toBe(0);
  });

  it('sends nothing for statuses without a template', async () => {
    expect(await handleOrderEvent(statusChanged(oid(), 'pending_payment', { previousStatus: null }), opts)).toBe('no_template');
    expect(await NotificationModel.countDocuments()).toBe(0);
  });

  it('deduplicates redeliveries and different events for the same transition', async () => {
    const orderId = oid();
    const evt = statusChanged(orderId, 'cancelled', { reason: 'Changed my mind' });
    expect(await handleOrderEvent(evt, opts)).toBe('queued');
    expect(await handleOrderEvent(evt, opts)).toBe('duplicate');
    expect(await handleOrderEvent(statusChanged(orderId, 'cancelled'), opts)).toBe('duplicate');
    expect(await NotificationModel.countDocuments({ orderId })).toBe(1);
  });

  it('handles out-of-order events: each transition is notified once, regardless of arrival order', async () => {
    const orderId = oid();
    await handleOrderEvent(statusChanged(orderId, 'out_for_delivery', { previousStatus: 'partner_assigned' }), opts);
    await handleOrderEvent(statusChanged(orderId, 'partner_assigned', { previousStatus: 'assigning_delivery_partner' }), opts);
    await handleOrderEvent(statusChanged(orderId, 'out_for_delivery', { previousStatus: 'partner_assigned' }), opts);
    const templates = (await NotificationModel.find({ orderId }).lean()).map((n) => n.template).sort();
    expect(templates).toEqual(['DELIVERY_PARTNER_ASSIGNED', 'OUT_FOR_DELIVERY']);
  });

  it('rejects malformed payloads as permanent (→ DLQ, no record)', async () => {
    const bad = statusChanged(oid(), 'confirmed');
    delete (bad.data as Record<string, unknown>).customerEmail;
    await expect(handleOrderEvent(bad, opts)).rejects.toBeInstanceOf(PermanentEventError);
    expect(await NotificationModel.countDocuments()).toBe(0);
  });
});

describe('Sender', () => {
  useTestDatabase();

  it('sends a queued notification and records the SMTP outcome', async () => {
    const mailer = new FakeMailer();
    const orderId = oid();
    await handleOrderEvent(statusChanged(orderId, 'confirmed'), opts);
    await new Sender(mailer, logger, senderOpts).run();

    expect(mailer.sent).toHaveLength(1);
    const [email] = mailer.sent;
    const n = (await NotificationModel.findOne({ orderId }).lean())!;
    expect(email).toMatchObject({ to: 'asha@example.com', messageId: `<${n._id}@notifications.food.local>` });
    expect(email!.headers).toMatchObject({ 'X-Order-Id': orderId, 'X-Template': 'ORDER_CONFIRMED' });
    expect(n).toMatchObject({ status: 'sent', attempts: 1, smtpResponse: '250 OK' });
    expect(n.sentAt).toBeInstanceOf(Date);
    expect(n.leaseUntil).toBeUndefined();
  });

  it('never re-sends a sent notification, even when the event is redelivered', async () => {
    const mailer = new FakeMailer();
    const sender = new Sender(mailer, logger, senderOpts);
    const evt = statusChanged(oid(), 'delivered', { previousStatus: 'location_reached' });
    await handleOrderEvent(evt, opts);
    await sender.run();
    await handleOrderEvent(evt, opts);
    await sender.run();
    expect(mailer.sent).toHaveLength(1);
  });

  it('retries after an SMTP outage with backoff and recovers', async () => {
    const mailer = new FakeMailer();
    mailer.failWith = new Error('connect ECONNREFUSED mailpit:1025');
    const sender = new Sender(mailer, logger, senderOpts);
    const orderId = oid();
    await handleOrderEvent(statusChanged(orderId, 'expired', { reason: 'Payment not completed in time' }), opts);

    await sender.run();
    let n = (await NotificationModel.findOne({ orderId }).lean())!;
    expect(n).toMatchObject({ status: 'pending', attempts: 1, lastError: expect.stringContaining('ECONNREFUSED') });
    expect(n.failures).toHaveLength(1);
    expect(n.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: nothing happens.
    await sender.run();
    expect((await NotificationModel.findOne({ orderId }).lean())!.attempts).toBe(1);

    mailer.failWith = undefined;
    await NotificationModel.updateOne({ orderId }, { $set: { nextAttemptAt: new Date() } }); // fast-forward the backoff
    await sender.run();
    n = (await NotificationModel.findOne({ orderId }).lean())!;
    expect(n).toMatchObject({ status: 'sent', attempts: 2 });
    expect(n.lastError).toBeUndefined();
    expect(n.failures).toHaveLength(1); // history of the failed attempt is kept
    expect(mailer.sent).toHaveLength(1);
  });

  it('gives up after maxAttempts and marks the notification failed', async () => {
    const mailer = new FakeMailer();
    mailer.failWith = new Error('ETIMEDOUT');
    const sender = new Sender(mailer, logger, senderOpts);
    const orderId = oid();
    await handleOrderEvent(statusChanged(orderId, 'confirmed'), opts);
    for (let i = 0; i < 3; i++) {
      await NotificationModel.updateOne({ orderId }, { $set: { nextAttemptAt: new Date() } });
      await sender.run();
    }
    const n = (await NotificationModel.findOne({ orderId }).lean())!;
    expect(n).toMatchObject({ status: 'failed', attempts: 3 });
    expect(n.failures).toHaveLength(3);
  });

  it('fails immediately on a permanent SMTP rejection (5xx)', async () => {
    const mailer = new FakeMailer();
    mailer.failWith = new PermanentMailError('SMTP 550: mailbox unavailable');
    const orderId = oid();
    await handleOrderEvent(statusChanged(orderId, 'confirmed'), opts);
    await new Sender(mailer, logger, senderOpts).run();
    expect((await NotificationModel.findOne({ orderId }).lean())!).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('recovers an attempt lost in a crash once its lease expires (restart)', async () => {
    const orderId = oid();
    await handleOrderEvent(statusChanged(orderId, 'confirmed'), opts);
    // First process claims the notification and dies mid-send.
    const crashed = new FakeMailer();
    crashed.hang = true;
    void new Sender(crashed, logger, { ...senderOpts, leaseMs: 200 }).sendNext();
    await new Promise((r) => setTimeout(r, 50));
    expect((await NotificationModel.findOne({ orderId }).lean())!.status).toBe('sending');

    // A new process does not steal a live lease…
    const restarted = new FakeMailer();
    const sender = new Sender(restarted, logger, senderOpts);
    await sender.run();
    expect(restarted.sent).toHaveLength(0);

    // …but picks it up after the lease expires.
    await new Promise((r) => setTimeout(r, 250));
    await sender.run();
    expect(restarted.sent).toHaveLength(1);
    expect((await NotificationModel.findOne({ orderId }).lean())!).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a failing notification does not block others', async () => {
    const mailer = new FakeMailer();
    const a = oid();
    const b = oid();
    await handleOrderEvent(statusChanged(a, 'confirmed', { email: 'bad@example.com' }), opts);
    await handleOrderEvent(statusChanged(b, 'confirmed'), opts);
    const send = mailer.send.bind(mailer);
    mailer.send = async (e) => (e.to === 'bad@example.com' ? Promise.reject(new Error('451 try later')) : send(e));
    await new Sender(mailer, logger, senderOpts).run();
    expect(mailer.sent.map((e) => e.to)).toEqual(['asha@example.com']);
    expect((await NotificationModel.findOne({ orderId: a }).lean())!.status).toBe('pending');
  });
});
