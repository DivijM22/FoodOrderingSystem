import mongoose, { type ClientSession, type Types } from 'mongoose';
import {
  enqueueEvent,
  EventTypes,
  PermanentEventError,
  type EventData,
  type EventType,
  type Logger,
} from '@food/common';
import { canApplyRefundOutcome, canTransition, CAPTURED, OPEN_INTENT, type PaymentStatus } from '../models/payment-status.js';
import { PaymentModel, type IPayment } from '../models/payment.model.js';
import { RefundModel, type IRefund } from '../models/refund.model.js';
import {
  IntentStateError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderIntent,
  type ProviderRefund,
} from '../providers/provider.js';

export const SERVICE_NAME = 'payment-service';
export const CANCELLATION_REFUND_KEY = (paymentId: string) => `order-cancelled:${paymentId}`;

export type ApplyResult = 'applied' | 'unchanged' | 'stale' | 'anomaly' | 'unknown';

/** Lost a compare-and-set race; callers (broker / webhook sender / reconciler) retry. */
export class ConcurrentUpdateError extends Error {}

type OrderCreated = EventData<typeof EventTypes.OrderCreated>;
type OrderCancelled = EventData<typeof EventTypes.OrderCancelled>;
type OrderExpired = EventData<typeof EventTypes.OrderExpired>;

/** The invoice fields the Payment Service needs (from billing.invoice_generated.v1 or Billing REST). */
export interface InvoiceRef {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  finalAmount: number;
  /** The order's payment deadline, when Billing carried it (billing.finalized). */
  expiresAt?: string;
}

/** An order closed without needing its payment: cancelled by someone, or expired unpaid. */
export interface OrderClosed {
  kind: 'cancelled' | 'expired';
  orderId: string;
  orderNumber: string;
  customerId: string;
  provisionalTotal: number;
  reason: string;
}

export const closedFromCancelled = (d: OrderCancelled): OrderClosed => ({
  kind: 'cancelled', orderId: d.orderId, orderNumber: d.orderNumber, customerId: d.customerId, provisionalTotal: d.provisionalTotal, reason: d.reason,
});
export const closedFromExpired = (d: OrderExpired): OrderClosed => ({
  kind: 'expired', orderId: d.orderId, orderNumber: d.orderNumber, customerId: d.customerId, provisionalTotal: d.provisionalTotal, reason: 'Payment deadline passed',
});

const BACKOFF_MAX_MS = 5 * 60_000;
const backoff = (attempts: number) => Math.min(1000 * 2 ** attempts, BACKOFF_MAX_MS);

/** Maps a Stripe PaymentIntent status onto our payment state machine. */
export function intentTarget(intent: ProviderIntent): PaymentStatus {
  switch (intent.status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
    case 'requires_capture':
      return 'processing';
    case 'canceled':
      return 'cancelled';
    case 'requires_payment_method':
      return intent.lastError ? 'failed' : 'requires_action';
    default:
      return 'requires_action';
  }
}

/**
 * All payment state changes live here. Every change is a compare-and-set on the current status,
 * made inside a MongoDB transaction together with the outbox event it produces — so state and
 * published events can never disagree. Provider (Stripe) calls are never made inside transactions.
 */
export class PaymentWorkflow {
  constructor(
    readonly provider: PaymentProvider,
    private readonly logger: Logger,
    /** Called after commits that may have produced outbox events or background work. */
    private readonly afterCommit: () => void = () => undefined,
    private readonly opts: { pollAfterMs?: number } = {},
  ) {}

  /** Signals that committed work is waiting (outbox events, reconciliation). */
  notify(): void {
    this.afterCommit();
  }

  async tx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      this.afterCommit();
      return result;
    } finally {
      await session.endSession();
    }
  }

  // ================================================================ order events

  /**
   * Invoice issued → fix the amount to charge. Set exactly once per payment (one invoice per order);
   * a different invoice for the same order is an anomaly. Creates the record if order.created lags.
   */
  async onInvoice(session: ClientSession, inv: InvoiceRef, source: string): Promise<'applied' | 'unchanged'> {
    const p = await PaymentModel.findOne({ orderId: inv.orderId }).session(session).lean();
    if (!p) {
      await PaymentModel.create(
        [
          {
            orderId: inv.orderId,
            orderNumber: inv.orderNumber,
            customerId: inv.customerId,
            amount: inv.finalAmount,
            invoiceId: inv.invoiceId,
            invoiceNumber: inv.invoiceNumber,
            ...(inv.expiresAt ? { expiresAt: new Date(inv.expiresAt) } : {}),
            currency: 'INR',
            status: 'pending',
            provider: this.provider.name,
            statusHistory: [{ status: 'pending', at: new Date(), source, note: `Invoice ${inv.invoiceNumber}` }],
          },
        ],
        { session },
      );
      return 'applied';
    }
    if (p.invoiceId) {
      if (p.invoiceId !== inv.invoiceId) throw new PermanentEventError(`Payment for order ${inv.orderId} is already bound to invoice ${p.invoiceId}`);
      return 'unchanged';
    }
    if (p.customerId !== inv.customerId) throw new PermanentEventError(`Customer mismatch for invoice ${inv.invoiceNumber}`);
    const res = await PaymentModel.updateOne(
      { _id: p._id, invoiceId: { $exists: false } },
      {
        $set: {
          amount: inv.finalAmount,
          invoiceId: inv.invoiceId,
          invoiceNumber: inv.invoiceNumber,
          ...(inv.expiresAt && !p.expiresAt ? { expiresAt: new Date(inv.expiresAt) } : {}),
        },
      },
      { session },
    );
    if (res.modifiedCount !== 1) throw new ConcurrentUpdateError(`Payment ${p._id} changed concurrently`);
    return 'applied';
  }

  /** order.created → one payment record per order (unique orderId; redelivery is a no-op). Amount comes later, from the invoice. */
  async onOrderCreated(session: ClientSession, d: OrderCreated): Promise<void> {
    await PaymentModel.updateOne(
      { orderId: d.orderId },
      {
        $setOnInsert: {
          orderId: d.orderId,
          orderNumber: d.orderNumber,
          customerId: d.customerId,
          currency: d.currency,
          ...(d.expiresAt ? { expiresAt: new Date(d.expiresAt) } : {}),
          status: 'pending',
          provider: this.provider.name,
          statusHistory: [{ status: 'pending', at: new Date(), source: 'event:order.created' }],
        },
      },
      { upsert: true, session },
    );
  }

  /**
   * order.cancelled / order.expired → record the closure durably, then:
   * - no PaymentIntent yet          → cancel immediately
   * - open PaymentIntent            → reconciler cancels it at Stripe (outside the transaction)
   * - captured                      → create the (single) automatic refund
   * Cancellation and expiry share one refund idempotency key, so together they still refund at most once.
   */
  async onOrderClosed(session: ClientSession, d: OrderClosed, source: string): Promise<void> {
    const label = d.kind === 'expired' ? 'Order expired' : 'Order cancelled';
    const now = new Date();
    const p = await PaymentModel.findOne({ orderId: d.orderId }).session(session).lean();

    if (!p) {
      // Cancelled before we ever saw order.created (or before it was processed): nothing can be charged.
      const [created] = await PaymentModel.create(
        [
          {
            orderId: d.orderId,
            orderNumber: d.orderNumber,
            customerId: d.customerId,
            currency: 'INR',
            status: 'cancelled',
            provider: this.provider.name,
            orderCancelledAt: now,
            orderCancelReason: d.reason,
            orderClosure: d.kind,
            statusHistory: [{ status: 'cancelled', at: now, source, note: `${label} before payment` }],
          },
        ],
        { session },
      );
      await this.emit(session, EventTypes.PaymentCancelled, created!.orderId, {
        paymentId: created!._id.toString(),
        orderId: created!.orderId,
        customerId: created!.customerId,
        amount: 0, // never charged
        reason: `${label}: ${d.reason}`,
        cancelledAt: now.toISOString(),
      });
      return;
    }
    if (p.orderCancelledAt) return; // already closed (repeated cancellation/expiry) — handled once

    await PaymentModel.updateOne(
      { _id: p._id },
      { $set: { orderCancelledAt: now, orderCancelReason: d.reason, orderClosure: d.kind, 'reconcile.nextAttemptAt': now, 'reconcile.attempts': 0 } },
      { session },
    );
    p.orderCancelledAt = now;
    p.orderCancelReason = d.reason;
    p.orderClosure = d.kind;

    if (p.status === 'pending') {
      await this.move(session, p, 'cancelled', source, `${label} before payment was initiated`);
      await this.emitCancelled(session, p, `${label}: ${d.reason}`);
    } else if (p.status === 'succeeded' || p.status === 'partially_refunded') {
      await this.requestCancellationRefund(session, p, source);
    }
    // OPEN_INTENT → reconciler; refund_pending → reconciler after the in-flight refund; terminal → nothing.
  }

  // ================================================================ provider truth

  /** Applies a PaymentIntent's (trusted) status to our record. Shared by webhooks, polling and initiation. */
  async applyIntent(session: ClientSession, paymentId: Types.ObjectId | string, intent: ProviderIntent, source: string): Promise<ApplyResult> {
    const p = await PaymentModel.findById(paymentId).session(session).lean();
    if (!p) return 'unknown';
    if (p.providerPaymentIntentId && p.providerPaymentIntentId !== intent.id) {
      this.logger.error({ paymentId: p._id, expected: p.providerPaymentIntentId, got: intent.id }, 'PaymentIntent does not belong to this payment');
      return 'anomaly';
    }
    // Also catches a PaymentIntent for a payment with no invoice amount (impossible by construction).
    if (p.amount === undefined || intent.amount !== p.amount || intent.currency.toLowerCase() !== p.currency.toLowerCase()) {
      this.logger.error({ paymentId: p._id, intentAmount: intent.amount, expected: p.amount }, 'PaymentIntent amount/currency mismatch; ignoring');
      return 'anomaly';
    }
    const amount = p.amount;

    const target = intentTarget(intent);
    if (target === p.status) return 'unchanged';
    if (p.status === 'cancelled' && target === 'succeeded') {
      // Impossible with an atomic provider (a cancelled PaymentIntent cannot be charged) — but if it
      // ever happens, money was taken for a closed order: make it loud for manual follow-up.
      this.logger.error({ paymentId: p._id, intent: intent.id }, 'Provider reports a charge on a cancelled payment; manual refund required');
      return 'anomaly';
    }
    if (!canTransition(p.status, target)) return 'stale'; // e.g. late payment_failed after success

    const set: Partial<IPayment> = p.providerPaymentIntentId ? {} : { providerPaymentIntentId: intent.id };
    const now = new Date();
    switch (target) {
      case 'succeeded':
        await this.move(session, p, 'succeeded', source, 'Payment captured', { ...set, paidAt: now });
        await this.emit(session, EventTypes.PaymentSucceeded, p.orderId, {
          paymentId: p._id.toString(),
          orderId: p.orderId,
          customerId: p.customerId,
          amount,
          currency: 'INR',
          provider: p.provider,
          providerReference: intent.id,
          ...(p.invoiceId ? { invoiceId: p.invoiceId } : {}),
          paidAt: now.toISOString(),
        });
        // Race: the order was cancelled while the customer was paying — refund, never keep the money.
        if (p.orderCancelledAt) await this.requestCancellationRefund(session, p, source);
        break;
      case 'failed': {
        const failure = { code: intent.lastError?.code, message: intent.lastError?.message ?? 'Payment failed', at: now };
        await this.move(session, p, 'failed', source, failure.message, { ...set, lastFailure: failure });
        await this.emit(session, EventTypes.PaymentFailed, p.orderId, {
          paymentId: p._id.toString(),
          orderId: p.orderId,
          customerId: p.customerId,
          amount,
          reason: failure.message,
          failureCode: failure.code,
          retryable: !p.orderCancelledAt,
          failedAt: now.toISOString(),
        });
        break;
      }
      case 'cancelled':
        await this.move(session, p, 'cancelled', source, 'PaymentIntent cancelled', set);
        await this.emitCancelled(session, p, p.orderCancelReason ?? 'PaymentIntent cancelled');
        break;
      default:
        await this.move(session, p, target, source, undefined, set);
    }
    return 'applied';
  }

  /** Applies a refund's (trusted) status. Stripe may report succeeded → failed later (refund reversal). */
  async applyRefund(session: ClientSession, refundId: Types.ObjectId | string, pr: ProviderRefund, source: string): Promise<ApplyResult> {
    const r = await RefundModel.findById(refundId).session(session).lean();
    if (!r) return 'unknown';
    if (r.providerRefundId && r.providerRefundId !== pr.id) return 'anomaly';
    if (!r.providerRefundId) {
      await RefundModel.updateOne({ _id: r._id }, { $set: { providerRefundId: pr.id, submittedAt: new Date() } }, { session });
      r.providerRefundId = pr.id;
    }
    if (pr.status === 'succeeded') {
      if (r.status !== 'pending') return r.status === 'succeeded' ? 'unchanged' : 'stale';
      await this.completeRefund(session, r, source);
      return 'applied';
    }
    if (pr.status === 'failed' || pr.status === 'canceled') {
      if (r.status === 'failed') return 'unchanged';
      await this.failRefund(session, r, pr.failureReason ?? `Refund ${pr.status}`, source);
      return 'applied';
    }
    return 'unchanged'; // pending / requires_action: wait for the next webhook or poll
  }

  /** Verified webhook entry point (idempotent by Stripe event id, see webhook route). */
  async handleProviderEvent(session: ClientSession, evt: ProviderEvent): Promise<ApplyResult> {
    const source = `webhook:${evt.id}`;
    if (evt.kind === 'intent') {
      let p = await PaymentModel.findOne({ providerPaymentIntentId: evt.intent.id }).session(session).lean();
      // The webhook can beat our own write of the PaymentIntent id; fall back to our metadata.
      if (!p && evt.intent.metadata.paymentId && mongoose.isValidObjectId(evt.intent.metadata.paymentId)) {
        p = await PaymentModel.findById(evt.intent.metadata.paymentId).session(session).lean();
      }
      if (!p) return 'unknown';
      return this.applyIntent(session, p._id, evt.intent, source);
    }
    if (evt.kind === 'refund') {
      let r = await RefundModel.findOne({ providerRefundId: evt.refund.id }).session(session).lean();
      if (!r && evt.refund.metadata.refundId && mongoose.isValidObjectId(evt.refund.metadata.refundId)) {
        r = await RefundModel.findById(evt.refund.metadata.refundId).session(session).lean();
      }
      if (!r) return 'unknown';
      return this.applyRefund(session, r._id, evt.refund, source);
    }
    return 'unchanged';
  }

  // ================================================================ refunds

  /** Creates a refund record (unique idempotency key) and moves the payment to refund_pending. */
  async requestRefund(
    session: ClientSession,
    p: IPayment,
    req: { amount: number; reason: string; requestedBy: string; idempotencyKey: string },
    source: string,
  ): Promise<IRefund> {
    const [refund] = await RefundModel.create(
      [{ paymentId: p._id.toString(), orderId: p.orderId, customerId: p.customerId, ...req, status: 'pending', nextAttemptAt: new Date() }],
      { session },
    );
    await this.move(session, p, 'refund_pending', source, `Refund of ${req.amount} paise requested (${req.reason})`, { refundStatus: 'pending' });
    return refund!.toObject();
  }

  /** At most one automatic refund per payment, guaranteed by its idempotency key. */
  async requestCancellationRefund(session: ClientSession, p: IPayment, source: string): Promise<void> {
    const remaining = (p.amount ?? 0) - p.refundedAmount;
    if (remaining <= 0 || !['succeeded', 'partially_refunded'].includes(p.status)) return;
    const key = CANCELLATION_REFUND_KEY(p._id.toString());
    if (await RefundModel.exists({ idempotencyKey: key }).session(session)) return;
    const why = p.orderClosure === 'expired' ? 'Order expired' : 'Order cancelled';
    await this.requestRefund(
      session,
      p,
      { amount: remaining, reason: `${why}: ${p.orderCancelReason ?? p.orderClosure ?? 'closed'}`, requestedBy: `system:order-${p.orderClosure ?? 'cancelled'}`, idempotencyKey: key },
      source,
    );
  }

  private async completeRefund(session: ClientSession, r: IRefund, source: string) {
    const res = await RefundModel.updateOne({ _id: r._id, status: 'pending' }, { $set: { status: 'succeeded', completedAt: new Date() } }, { session });
    if (res.modifiedCount !== 1) throw new ConcurrentUpdateError(`Refund ${r._id} changed concurrently`);
    const p = (await PaymentModel.findById(r.paymentId).session(session).lean())!;
    const total = p.refundedAmount + r.amount;
    const full = total >= (p.amount ?? 0);
    const to: PaymentStatus = full ? 'refunded' : 'partially_refunded';
    if (!canApplyRefundOutcome(p.status, to)) throw new ConcurrentUpdateError(`Cannot complete refund while payment is ${p.status}`);
    await this.move(session, p, to, source, `Refund ${r._id} succeeded`, { refundedAmount: total, refundStatus: 'succeeded' }, true);
    await this.emit(session, EventTypes.RefundCompleted, p.orderId, {
      refundId: r._id.toString(),
      paymentId: p._id.toString(),
      orderId: p.orderId,
      customerId: p.customerId,
      amount: r.amount,
      totalRefunded: total,
      fullyRefunded: full,
      providerReference: r.providerRefundId ?? 'unknown',
      refundedAt: new Date().toISOString(),
    });
    // e.g. an admin partial refund finished after the order was cancelled: refund the remainder too.
    if (p.orderCancelledAt && !full) await this.requestCancellationRefund(session, p, source);
  }

  private async failRefund(session: ClientSession, r: IRefund, reason: string, source: string) {
    const wasSucceeded = r.status === 'succeeded';
    const res = await RefundModel.updateOne(
      { _id: r._id, status: r.status },
      { $set: { status: 'failed', failure: { message: reason }, completedAt: new Date() } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new ConcurrentUpdateError(`Refund ${r._id} changed concurrently`);
    const p = (await PaymentModel.findById(r.paymentId).session(session).lean())!;
    const total = wasSucceeded ? p.refundedAmount - r.amount : p.refundedAmount;
    const to: PaymentStatus = total > 0 ? 'partially_refunded' : 'succeeded';
    if (!canApplyRefundOutcome(p.status, to)) throw new ConcurrentUpdateError(`Cannot record refund failure while payment is ${p.status}`);
    await this.move(session, p, to, source, `Refund ${r._id} failed: ${reason}`, { refundedAmount: total, refundStatus: 'failed' }, true);
    await this.emit(session, EventTypes.RefundFailed, p.orderId, {
      refundId: r._id.toString(),
      paymentId: p._id.toString(),
      orderId: p.orderId,
      customerId: p.customerId,
      amount: r.amount,
      reason,
      failedAt: new Date().toISOString(),
    });
    // Not retried automatically: a failed refund (e.g. closed card) needs a human decision.
  }

  // ================================================================ reconciler (provider calls)

  /** One pass of background work. Safe to run concurrently with webhooks (everything is compare-and-set). */
  async reconcile(): Promise<void> {
    const now = new Date();
    const due = { $or: [{ 'reconcile.nextAttemptAt': { $exists: false } }, { 'reconcile.nextAttemptAt': { $lte: now } }] };

    // 1. Cancel open PaymentIntents of cancelled orders.
    for (const p of await PaymentModel.find({ orderCancelledAt: { $exists: true }, status: { $in: OPEN_INTENT }, ...due }).limit(50).lean()) {
      await this.guard(p._id, 'payment', () => this.cancelOpenIntent(p));
    }
    // 2. Captured payments of cancelled orders that still need their refund (e.g. one was in flight earlier).
    for (const p of await PaymentModel.find({ orderCancelledAt: { $exists: true }, status: { $in: ['succeeded', 'partially_refunded'] }, refundStatus: { $ne: 'failed' } }).limit(50).lean()) {
      await this.guard(p._id, 'payment', () => this.tx((s) => this.requestCancellationRefund(s, p, 'reconciler')));
    }
    // 3. Submit refunds that have not reached the provider yet.
    for (const r of await RefundModel.find({ status: 'pending', providerRefundId: { $exists: false }, nextAttemptAt: { $lte: now } }).limit(50).lean()) {
      await this.guard(r._id, 'refund', () => this.submitRefund(r));
    }
    // 4. Poll refunds still pending at the provider (lost webhook / slow refund).
    const stale = new Date(now.getTime() - (this.opts.pollAfterMs ?? 60_000));
    for (const r of await RefundModel.find({ status: 'pending', providerRefundId: { $exists: true }, submittedAt: { $lte: stale }, nextAttemptAt: { $lte: now } }).limit(50).lean()) {
      await this.guard(r._id, 'refund', async () => {
        const pr = await this.provider.retrieveRefund(r.providerRefundId!);
        const result = await this.tx((s) => this.applyRefund(s, r._id, pr, 'reconciler:poll'));
        if (result === 'unchanged') await this.defer('refund', r._id, r.attempts, 'still pending at provider');
      });
    }
    // 5. Poll PaymentIntents stuck in processing.
    for (const p of await PaymentModel.find({ status: 'processing', updatedAt: { $lte: stale }, providerPaymentIntentId: { $exists: true }, ...due }).limit(50).lean()) {
      await this.guard(p._id, 'payment', async () => {
        const intent = await this.provider.retrievePaymentIntent(p.providerPaymentIntentId!);
        const result = await this.tx((s) => this.applyIntent(s, p._id, intent, 'reconciler:poll'));
        if (result !== 'applied') await this.defer('payment', p._id, p.reconcile?.attempts ?? 0, 'still processing at provider');
      });
    }
  }

  private async cancelOpenIntent(p: IPayment) {
    if (!p.providerPaymentIntentId) {
      await this.tx(async (s) => {
        const fresh = (await PaymentModel.findById(p._id).session(s).lean())!;
        if (OPEN_INTENT.includes(fresh.status)) {
          await this.move(s, fresh, 'cancelled', 'reconciler', 'Order cancelled');
          await this.emitCancelled(s, fresh, fresh.orderCancelReason ?? 'Order cancelled');
        }
      });
      return;
    }
    let intent: ProviderIntent;
    try {
      intent = await this.provider.cancelPaymentIntent(p.providerPaymentIntentId, `cancel:${p._id}`);
    } catch (err) {
      if (!(err instanceof IntentStateError)) throw err;
      // Too late to cancel (it succeeded meanwhile): learn the truth; success then triggers the refund.
      intent = await this.provider.retrievePaymentIntent(p.providerPaymentIntentId);
    }
    const result = await this.tx((s) => this.applyIntent(s, p._id, intent, 'reconciler'));
    if (intent.status === 'processing' || result === 'unchanged') await this.defer('payment', p._id, p.reconcile?.attempts ?? 0, `intent is ${intent.status}`);
  }

  private async submitRefund(r: IRefund) {
    const p = await PaymentModel.findById(r.paymentId).lean();
    if (!p?.providerPaymentIntentId) {
      await this.tx((s) => this.failRefund(s, r, 'Payment has no PaymentIntent to refund', 'reconciler'));
      return;
    }
    try {
      const pr = await this.provider.createRefund(
        { paymentIntentId: p.providerPaymentIntentId, amount: r.amount, metadata: { refundId: r._id.toString(), paymentId: r.paymentId, orderId: r.orderId } },
        `refund:${r._id}`, // same key on every retry → the provider never creates a second refund
      );
      await this.tx((s) => this.applyRefund(s, r._id, pr, 'reconciler:submit'));
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        await this.tx((s) => this.failRefund(s, r, `Provider rejected refund: ${err.message}`, 'reconciler'));
        return;
      }
      throw err;
    }
  }

  /** Runs one unit of reconciliation; transient failures are rescheduled with exponential backoff. */
  private async guard(id: Types.ObjectId, kind: 'payment' | 'refund', fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      const attempts = kind === 'payment'
        ? ((await PaymentModel.findById(id, { reconcile: 1 }).lean())?.reconcile?.attempts ?? 0)
        : ((await RefundModel.findById(id, { attempts: 1 }).lean())?.attempts ?? 0);
      await this.defer(kind, id, attempts, (err as Error).message);
      const level = err instanceof ProviderUnavailableError || err instanceof ConcurrentUpdateError ? 'warn' : 'error';
      this.logger[level]({ err: (err as Error).message, kind, id: id.toString(), attempts: attempts + 1 }, 'Reconciliation step failed; will retry');
    }
  }

  private async defer(kind: 'payment' | 'refund', id: Types.ObjectId, attempts: number, reason: string) {
    const next = new Date(Date.now() + backoff(attempts));
    if (kind === 'payment') {
      await PaymentModel.updateOne({ _id: id }, { $set: { 'reconcile.nextAttemptAt': next, 'reconcile.lastError': reason }, $inc: { 'reconcile.attempts': 1 } });
    } else {
      await RefundModel.updateOne({ _id: id }, { $set: { nextAttemptAt: next, lastError: reason }, $inc: { attempts: 1 } });
    }
  }

  // ================================================================ primitives

  /** Compare-and-set status transition; mutates `p` to reflect the new state. */
  async move(
    session: ClientSession,
    p: IPayment,
    to: PaymentStatus,
    source: string,
    note?: string,
    set: Partial<IPayment> = {},
    force = false,
  ): Promise<void> {
    if (!force && !canTransition(p.status, to)) throw new ConcurrentUpdateError(`Illegal payment transition ${p.status} → ${to}`);
    const res = await PaymentModel.updateOne(
      { _id: p._id, status: p.status },
      { $set: { status: to, ...set }, $push: { statusHistory: { status: to, at: new Date(), source, note } } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new ConcurrentUpdateError(`Payment ${p._id} changed concurrently`);
    Object.assign(p, set, { status: to });
  }

  private emitCancelled(session: ClientSession, p: IPayment, reason: string) {
    return this.emit(session, EventTypes.PaymentCancelled, p.orderId, {
      paymentId: p._id.toString(),
      orderId: p.orderId,
      customerId: p.customerId,
      amount: p.amount ?? 0,
      reason,
      cancelledAt: new Date().toISOString(),
    });
  }

  private emit<T extends EventType>(session: ClientSession, eventType: T, orderId: string, data: EventData<T>) {
    return enqueueEvent(session, { source: SERVICE_NAME, eventType, aggregateId: orderId, data });
  }
}

export { CAPTURED };
