import { randomBytes } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import Stripe from 'stripe';
import type { Logger } from '@food/common';
import {
  IntentStateError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type IntentStatus,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderIntent,
  type ProviderRefund,
  type ProviderRefundStatus,
  type SimulatedOutcome,
} from './provider.js';
import { verifyAndNormalise } from './stripe-events.js';

/**
 * ⚠️ MOCK PAYMENT PROVIDER — for local development and automated tests only.
 *
 * Simulates the parts of Stripe this service uses: PaymentIntents, refunds, idempotency keys and
 * signed webhooks. Webhooks are signed with Stripe's own scheme (via the official SDK) so the
 * service's real verification code runs unchanged. Everything it creates is labelled
 * (`pi_mock_…`, `re_mock_…`, `evt_mock_…`, `livemode: false`, payment.provider = "mock").
 * It never contacts Stripe and nothing it produces is a Stripe transaction.
 *
 * State lives in `mock_provider_objects` so simulated intents survive service restarts.
 */

interface MockObject {
  _id: string;
  kind: 'payment_intent' | 'refund' | 'idempotency';
  data: Record<string, unknown>;
}

const MockObjectModel =
  (mongoose.models.MockProviderObject as mongoose.Model<MockObject> | undefined) ??
  mongoose.model<MockObject>(
    'MockProviderObject',
    new Schema<MockObject>(
      { _id: String, kind: { type: String, required: true }, data: { type: Schema.Types.Mixed, required: true } },
      { versionKey: false, collection: 'mock_provider_objects', minimize: false },
    ),
  );

interface MockIntent {
  id: string;
  status: IntentStatus;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  client_secret: string;
  description: string;
  last_payment_error: { code: string; decline_code?: string; message: string } | null;
  amount_refunded: number;
  refund_fails: boolean;
  created: number;
}

interface MockRefund {
  id: string;
  status: ProviderRefundStatus;
  amount: number;
  payment_intent: string;
  metadata: Record<string, string>;
  failure_reason: string | null;
  created: number;
}

export type WebhookDeliverer = (payload: string, signature: string) => Promise<void>;
type FailableOp = 'createPaymentIntent' | 'retrievePaymentIntent' | 'cancelPaymentIntent' | 'createRefund' | 'retrieveRefund';

const CONFIRMABLE: IntentStatus[] = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
const CANCELLABLE: IntentStatus[] = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'];

const rid = (prefix: string) => `${prefix}_mock_${randomBytes(12).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  /** Fault injection for tests: next N calls of an operation fail with a transient error. */
  private failures = new Map<FailableOp, number>();
  private pending = new Set<Promise<void>>();

  constructor(
    private readonly webhookSecret: string,
    private deliver: WebhookDeliverer,
    private readonly logger?: Logger,
    /** Delay before "Stripe" settles an async refund and sends its webhook. */
    private readonly refundSettleMs = 200,
  ) {}

  /** Builds a deliverer that POSTs to a URL like Stripe does, retrying failed deliveries a few times. */
  static httpDeliverer(url: string, logger?: Logger): WebhookDeliverer {
    return async (payload, signature) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': signature },
            body: payload,
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) return;
          logger?.warn({ status: res.status, attempt }, 'Mock webhook delivery rejected; retrying');
        } catch (err) {
          logger?.warn({ err: (err as Error).message, attempt }, 'Mock webhook delivery failed; retrying');
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
      logger?.error('Mock webhook delivery gave up after 5 attempts');
    };
  }

  setDeliverer(deliver: WebhookDeliverer) {
    this.deliver = deliver;
  }

  failNext(op: FailableOp, times = 1) {
    this.failures.set(op, times);
  }

  /** Test helper: number of PaymentIntents ever created. */
  async countIntents(): Promise<number> {
    return MockObjectModel.countDocuments({ kind: 'payment_intent' });
  }

  /** Resolves once every scheduled webhook has been delivered (tests). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  // ------------------------------------------------------------------ PaymentProvider

  async createPaymentIntent(
    params: { amount: number; currency: 'INR'; description: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<ProviderIntent> {
    this.maybeFail('createPaymentIntent');
    const existing = await this.idempotent(idempotencyKey);
    if (existing) return this.toIntent(await this.loadIntent(existing));

    const id = rid('pi');
    const intent: MockIntent = {
      id,
      status: 'requires_payment_method',
      amount: params.amount,
      currency: params.currency.toLowerCase(),
      metadata: params.metadata,
      client_secret: `${id}_secret_${randomBytes(8).toString('hex')}`,
      description: params.description,
      last_payment_error: null,
      amount_refunded: 0,
      refund_fails: false,
      created: now(),
    };
    // Persist the object first, then claim the idempotency key: a concurrent request that sees the
    // key can always load the object. The loser of the claim discards its copy and returns the winner's.
    await this.save('payment_intent', intent);
    try {
      await MockObjectModel.create({ _id: `idem:${idempotencyKey}`, kind: 'idempotency', data: { objectId: id } });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      await MockObjectModel.deleteOne({ _id: id });
      return this.toIntent(await this.loadIntent((await this.idempotent(idempotencyKey))!));
    }
    return this.toIntent(intent);
  }

  async retrievePaymentIntent(id: string): Promise<ProviderIntent> {
    this.maybeFail('retrievePaymentIntent');
    return this.toIntent(await this.loadIntent(id));
  }

  async cancelPaymentIntent(id: string, idempotencyKey: string): Promise<ProviderIntent> {
    this.maybeFail('cancelPaymentIntent');
    void idempotencyKey; // cancel is naturally idempotent here
    // Atomic compare-and-set, like Stripe: a concurrent confirmation and cancellation cannot both win.
    const intent = await this.transitionIntent(id, CANCELLABLE, { status: 'canceled' });
    if (!intent) {
      const current = await this.loadIntent(id);
      if (current.status === 'canceled') return this.toIntent(current);
      throw new IntentStateError(`This PaymentIntent's status is ${current.status}; it can no longer be canceled`);
    }
    this.emit('payment_intent.canceled', intent);
    return this.toIntent(intent);
  }

  async createRefund(
    params: { paymentIntentId: string; amount: number; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<ProviderRefund> {
    this.maybeFail('createRefund');
    const existing = await this.idempotent(idempotencyKey);
    if (existing) return this.toRefund(await this.loadRefund(existing));

    const intent = await this.loadIntent(params.paymentIntentId);
    if (intent.status !== 'succeeded') throw new ProviderRejectedError('PaymentIntent has no successful charge to refund', 'charge_not_succeeded');
    const refund: MockRefund = {
      id: rid('re'),
      status: 'pending',
      amount: params.amount,
      payment_intent: intent.id,
      metadata: params.metadata,
      failure_reason: null,
      created: now(),
    };
    await this.save('refund', refund);
    try {
      await MockObjectModel.create({ _id: `idem:${idempotencyKey}`, kind: 'idempotency', data: { objectId: refund.id } });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      await MockObjectModel.deleteOne({ _id: refund.id });
      return this.toRefund(await this.loadRefund((await this.idempotent(idempotencyKey))!));
    }
    // Atomically reserve the amount (no over-refund under concurrency).
    const reserved = await MockObjectModel.updateOne(
      { _id: intent.id, 'data.status': 'succeeded', $expr: { $lte: [{ $add: ['$data.amount_refunded', params.amount] }, '$data.amount'] } },
      { $inc: { 'data.amount_refunded': params.amount } },
    );
    if (reserved.modifiedCount !== 1) {
      await MockObjectModel.deleteMany({ _id: { $in: [refund.id, `idem:${idempotencyKey}`] } });
      throw new ProviderRejectedError('Refund amount exceeds the remaining charge amount', 'amount_too_large');
    }
    this.emit('refund.created', refund);

    // Like Stripe, the refund settles asynchronously and the outcome arrives as a webhook.
    this.track(
      new Promise<void>((resolve) => setTimeout(resolve, this.refundSettleMs)).then(async () => {
        const r = await this.loadRefund(refund.id);
        if (intent.refund_fails) {
          r.status = 'failed';
          r.failure_reason = 'expired_or_canceled_card';
          await MockObjectModel.updateOne({ _id: intent.id }, { $inc: { 'data.amount_refunded': -r.amount } });
          await this.save('refund', r);
          this.emit('refund.failed', r);
        } else {
          r.status = 'succeeded';
          await this.save('refund', r);
          this.emit('refund.updated', r);
        }
      }),
    );
    return this.toRefund(refund);
  }

  async retrieveRefund(id: string): Promise<ProviderRefund> {
    this.maybeFail('retrieveRefund');
    return this.toRefund(await this.loadRefund(id));
  }

  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): ProviderEvent {
    return verifyAndNormalise(rawBody, signature, this.webhookSecret);
  }

  async simulateCustomerPayment(intentId: string, outcome: SimulatedOutcome, opts: { deliveries?: number } = {}): Promise<void> {
    const deliveries = opts.deliveries ?? 1;
    const changes: Record<SimulatedOutcome, Partial<MockIntent>> = {
      succeed: { status: 'succeeded', last_payment_error: null, refund_fails: false },
      succeed_refund_fails: { status: 'succeeded', last_payment_error: null, refund_fails: true },
      fail: { status: 'requires_payment_method', last_payment_error: { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined. (mock)' } },
      processing: { status: 'processing' },
    };
    const intent = await this.transitionIntent(intentId, CONFIRMABLE, changes[outcome]);
    if (!intent) {
      const current = await this.loadIntent(intentId);
      throw new IntentStateError(`Cannot confirm a PaymentIntent in status ${current.status}`);
    }
    const type = { succeed: 'payment_intent.succeeded', succeed_refund_fails: 'payment_intent.succeeded', fail: 'payment_intent.payment_failed', processing: 'payment_intent.processing' }[outcome];
    this.emit(type, intent, deliveries);
  }

  /** Test helper: completes a `processing` intent (e.g. a delayed bank confirmation). */
  async settleProcessing(intentId: string, outcome: 'succeed' | 'fail'): Promise<void> {
    const reset = await this.transitionIntent(intentId, ['processing'], { status: 'requires_payment_method' });
    if (!reset) throw new IntentStateError(`Intent is not processing`);
    await this.simulateCustomerPayment(intentId, outcome);
  }

  /** Builds and signs a webhook exactly like Stripe would; exposed so tests can replay/duplicate deliveries. */
  signedWebhook(type: string, object: object, eventId = rid('evt')): { payload: string; signature: string; eventId: string } {
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      api_version: Stripe.API_VERSION,
      created: now(),
      livemode: false,
      type,
      data: { object },
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: this.webhookSecret });
    return { payload, signature, eventId };
  }

  // ------------------------------------------------------------------ internals

  private emit(type: string, object: MockIntent | MockRefund, deliveries = 1) {
    const stripeShaped = 'client_secret' in object ? { ...object, object: 'payment_intent' } : { ...object, object: 'refund' };
    const { payload, signature } = this.signedWebhook(type, stripeShaped);
    for (let i = 0; i < deliveries; i++) {
      // Same event id on every delivery — exactly how Stripe redelivers.
      this.track(
        new Promise<void>((r) => setTimeout(r, 20)).then(() =>
          this.deliver(payload, signature).catch((err) => this.logger?.error({ err }, 'Mock webhook delivery failed')),
        ),
      );
    }
  }

  private track(p: Promise<void>) {
    const tracked = p.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private maybeFail(op: FailableOp) {
    const n = this.failures.get(op) ?? 0;
    if (n > 0) {
      this.failures.set(op, n - 1);
      throw new ProviderUnavailableError(`Mock provider: injected transient failure in ${op}`);
    }
  }

  /** Atomically applies `changes` if the intent is currently in one of `from`; returns the new intent or null. */
  private async transitionIntent(id: string, from: readonly IntentStatus[], changes: Partial<MockIntent>): Promise<MockIntent | null> {
    const $set = Object.fromEntries(Object.entries(changes).map(([k, v]) => [`data.${k}`, v]));
    const doc = await MockObjectModel.findOneAndUpdate(
      { _id: id, kind: 'payment_intent', 'data.status': { $in: from } },
      { $set },
      { returnDocument: 'after' },
    ).lean();
    return doc ? (doc.data as unknown as MockIntent) : null;
  }

  private async idempotent(key: string): Promise<string | undefined> {
    const doc = await MockObjectModel.findById(`idem:${key}`).lean();
    return doc?.data.objectId as string | undefined;
  }

  private async save(kind: 'payment_intent' | 'refund', obj: MockIntent | MockRefund) {
    await MockObjectModel.updateOne({ _id: obj.id }, { $set: { kind, data: obj } }, { upsert: true });
  }

  private async loadIntent(id: string): Promise<MockIntent> {
    const doc = await MockObjectModel.findById(id).lean();
    if (!doc || doc.kind !== 'payment_intent') throw new ProviderRejectedError(`No such payment_intent: '${id}'`, 'resource_missing');
    return doc.data as unknown as MockIntent;
  }

  private async loadRefund(id: string): Promise<MockRefund> {
    const doc = await MockObjectModel.findById(id).lean();
    if (!doc || doc.kind !== 'refund') throw new ProviderRejectedError(`No such refund: '${id}'`, 'resource_missing');
    return doc.data as unknown as MockRefund;
  }

  private toIntent(i: MockIntent): ProviderIntent {
    return {
      id: i.id,
      status: i.status,
      amount: i.amount,
      currency: i.currency,
      metadata: i.metadata,
      clientSecret: i.client_secret,
      lastError: i.last_payment_error ? { code: i.last_payment_error.decline_code ?? i.last_payment_error.code, message: i.last_payment_error.message } : undefined,
    };
  }

  private toRefund(r: MockRefund): ProviderRefund {
    return { id: r.id, status: r.status, amount: r.amount, paymentIntentId: r.payment_intent, metadata: r.metadata, failureReason: r.failure_reason ?? undefined };
  }
}
