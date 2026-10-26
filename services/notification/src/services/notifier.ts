import type { KeyObject } from 'node:crypto';
import { EventTypes, parseEventData, PermanentEventError, sealedBox, type EventEnvelope, type Logger } from '@food/common';
import { NotificationModel, type INotification, type NotificationContext, type OtpContext } from '../models/notification.model.js';
import { render, renderOtp, TEMPLATE_FOR_STATUS, type TemplateName } from '../templates/index.js';
import { PermanentMailError, type Mailer } from './mailer.js';

export type HandleResult = 'queued' | 'duplicate' | 'ignored' | 'no_template';

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;
const backoff = (attempts: number) => Math.min(1000 * 2 ** attempts, 10 * 60_000);

/**
 * Turns customer-facing order events into durable notification records.
 * - Only order.status_changed.v1 produces email (the queue is bound to order.#; other order events are
 *   acknowledged and ignored, so specific + general events about one transition never send two emails).
 * - Durable processing = inserting the record (unique dedupeKey). The RabbitMQ message is acked only
 *   after that insert; actual sending happens in the Sender, so an SMTP outage never blocks the queue.
 */
export async function handleOrderEvent(event: EventEnvelope, opts: { maxAttempts: number }): Promise<HandleResult> {
  if (event.eventType !== EventTypes.OrderStatusChanged) return 'ignored';
  const d = parseEventData(event, EventTypes.OrderStatusChanged); // malformed → PermanentEventError → DLQ
  const template = TEMPLATE_FOR_STATUS[d.status];
  if (!template) return 'no_template';
  try {
    await NotificationModel.create({
      dedupeKey: `order:${d.orderId}:status:${d.status}`,
      sourceEventId: event.eventId,
      eventType: event.eventType,
      orderId: d.orderId,
      customerId: d.customerId,
      recipient: d.customerEmail,
      template,
      context: {
        orderNumber: d.orderNumber,
        customerName: d.customerName,
        status: d.status,
        previousStatus: d.previousStatus,
        changedAt: d.changedAt,
        ...(d.reason ? { reason: d.reason } : {}),
        summary: d.summary,
        metadata: d.metadata,
      },
      maxAttempts: opts.maxAttempts,
      nextAttemptAt: new Date(),
      failures: [],
    });
    return 'queued';
  } catch (err) {
    if (isDuplicateKey(err)) return 'duplicate'; // redelivery or another event for the same transition
    throw err;
  }
}

export const OTP_TEMPLATE = 'DELIVERY_OTP';

/**
 * Restricted `notification.delivery_otp.v1` command → durable record. The sealed code is checked here
 * (wrong key / tampered → dead-lettered, nothing stored) and kept only in sealed form until sent.
 * One record per (delivery, OTP sequence).
 */
export async function handleOtpCommand(event: EventEnvelope, opts: { maxAttempts: number; privateKey: KeyObject }): Promise<HandleResult> {
  if (event.eventType !== EventTypes.DeliveryOtpNotification) throw new PermanentEventError(`Unexpected restricted event ${event.eventType}`);
  const d = parseEventData(event, EventTypes.DeliveryOtpNotification);
  try {
    sealedBox.open(d.otpCiphertext, opts.privateKey);
  } catch {
    throw new PermanentEventError(`Delivery code for ${d.deliveryId} could not be opened`); // never echo the box
  }
  const context: OtpContext = {
    orderNumber: d.orderNumber,
    customerName: d.customerName,
    agentName: d.agentName,
    deliveryId: d.deliveryId,
    otpSequence: d.otpSequence,
    otpExpiresAt: d.otpExpiresAt,
  };
  try {
    await NotificationModel.create({
      dedupeKey: `delivery:${d.deliveryId}:otp:${d.otpSequence}`,
      sourceEventId: event.eventId,
      eventType: event.eventType,
      orderId: d.orderId,
      customerId: d.customerId,
      recipient: d.customerEmail,
      template: OTP_TEMPLATE,
      context,
      secretCiphertext: d.otpCiphertext,
      notAfter: new Date(d.otpExpiresAt),
      maxAttempts: opts.maxAttempts,
      nextAttemptAt: new Date(),
      failures: [],
    });
    return 'queued';
  } catch (err) {
    if (isDuplicateKey(err)) return 'duplicate';
    throw err;
  }
}

/**
 * Sends queued notifications with durable attempt tracking:
 * claim (status → sending, attempts+1, lease) → SMTP → mark sent / schedule retry / fail.
 * SMTP acceptance and the "sent" write cannot be atomic: if the process dies after SMTP accepted the
 * message but before it was marked sent, the lease expires and the email is sent again (at-least-once).
 * The Message-ID is stable per notification, so such a duplicate is recognisable.
 */
export class Sender {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly mailer: Mailer,
    private readonly logger: Logger,
    private readonly opts: { intervalMs: number; leaseMs: number; appName: string; messageIdDomain?: string; otpPrivateKey?: KeyObject },
  ) {}

  start() {
    this.timer = setInterval(() => void this.run(), this.opts.intervalMs);
    this.timer.unref();
    this.kick();
  }

  async stop() {
    clearInterval(this.timer);
    await this.running;
  }

  kick() {
    void this.run();
  }

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          while (await this.sendNext()) {
            /* drain */
          }
        } catch (err) {
          this.logger.error({ err }, 'Notification sender pass failed');
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Claims and sends one due notification. Returns false when nothing is due. */
  async sendNext(): Promise<boolean> {
    const now = new Date();
    const n = await NotificationModel.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } },
          { status: 'sending', leaseUntil: { $lt: now } }, // attempt lost (crash) → retry
        ],
      },
      { $set: { status: 'sending', leaseUntil: new Date(now.getTime() + this.opts.leaseMs) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    )
      .select('+secretCiphertext')
      .lean();
    if (!n) return false;
    await this.attempt(n);
    return true;
  }

  /** Gives up on a notification without sending (and drops any sealed secret). */
  private async abandon(n: INotification, reason: string) {
    await NotificationModel.updateOne(
      { _id: n._id, status: 'sending' },
      { $set: { status: 'failed', lastError: reason }, $unset: { leaseUntil: 1, secretCiphertext: 1 }, $push: { failures: { $each: [{ at: new Date(), error: reason }], $slice: -10 } } },
    );
    this.logger.warn({ notificationId: n._id, orderId: n.orderId, template: n.template, reason }, 'Notification abandoned');
  }

  /** Renders the email; for the delivery code, opens the sealed code in memory (never logged or stored). */
  private async renderFor(n: INotification): Promise<{ subject: string; text: string; html: string } | null> {
    if (n.template !== OTP_TEMPLATE) return render(n.template as TemplateName, n.context as NotificationContext, this.opts.appName);
    const ctx = n.context as OtpContext;
    if (!n.secretCiphertext || !n.notAfter || n.notAfter.getTime() <= Date.now()) {
      await this.abandon(n, 'Delivery code expired before it could be sent (the partner can request a new one)');
      return null;
    }
    const newer = await NotificationModel.exists({ template: OTP_TEMPLATE, 'context.deliveryId': ctx.deliveryId, 'context.otpSequence': { $gt: ctx.otpSequence } });
    if (newer) {
      await this.abandon(n, 'Superseded by a newer delivery code');
      return null;
    }
    if (!this.opts.otpPrivateKey) throw new Error('Delivery code key not configured'); // transient: retried once configured
    return renderOtp(ctx, sealedBox.open(n.secretCiphertext, this.opts.otpPrivateKey), this.opts.appName);
  }

  private async attempt(n: INotification) {
    let email;
    try {
      email = await this.renderFor(n);
    } catch (err) {
      email = undefined;
      await NotificationModel.updateOne(
        { _id: n._id, status: 'sending' },
        { $set: { status: 'pending', lastError: (err as Error).message, nextAttemptAt: new Date(Date.now() + backoff(n.attempts)) }, $unset: { leaseUntil: 1 } },
      );
      this.logger.error({ notificationId: n._id, template: n.template, err: (err as Error).message }, 'Notification could not be rendered; will retry');
      return;
    }
    if (!email) return;
    try {
      const res = await this.mailer.send({
        to: n.recipient,
        ...email,
        messageId: `<${n._id.toString()}@${this.opts.messageIdDomain ?? 'notifications.food.local'}>`,
        headers: { 'X-Notification-Id': n._id.toString(), 'X-Order-Id': n.orderId, 'X-Template': n.template },
      });
      await NotificationModel.updateOne(
        { _id: n._id, status: 'sending' },
        { $set: { status: 'sent', sentAt: new Date(), smtpMessageId: res.messageId, smtpResponse: res.response }, $unset: { leaseUntil: 1, lastError: 1, secretCiphertext: 1 } },
      );
      this.logger.info({ notificationId: n._id, orderId: n.orderId, template: n.template, attempts: n.attempts }, 'Notification sent');
    } catch (err) {
      const message = (err as Error).message;
      const permanent = err instanceof PermanentMailError;
      // Delivery codes are short-lived: retry fast and until the code expires, instead of a fixed attempt count.
      const isOtp = n.template === OTP_TEMPLATE;
      const delay = isOtp ? Math.min(backoff(n.attempts), 15_000) : backoff(n.attempts);
      const giveUp = permanent || (isOtp ? !n.notAfter || Date.now() + delay >= n.notAfter.getTime() : n.attempts >= n.maxAttempts);
      await NotificationModel.updateOne(
        { _id: n._id, status: 'sending' },
        {
          $set: giveUp
            ? { status: 'failed', lastError: message }
            : { status: 'pending', lastError: message, nextAttemptAt: new Date(Date.now() + delay) },
          $unset: giveUp ? { leaseUntil: 1, secretCiphertext: 1 } : { leaseUntil: 1 },
          $push: { failures: { $each: [{ at: new Date(), error: message.slice(0, 300) }], $slice: -10 } },
        },
      );
      this.logger[giveUp ? 'error' : 'warn']({ notificationId: n._id, orderId: n.orderId, attempts: n.attempts, err: message }, giveUp ? 'Notification failed permanently' : 'Notification send failed; will retry');
    }
  }
}
