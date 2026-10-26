import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  type AuthUser,
} from '@food/common';
import type { QueryFilter } from 'mongoose';
import { CAPTURED, type PaymentStatus } from '../models/payment-status.js';
import { PaymentModel, toPublicPayment, type IPayment } from '../models/payment.model.js';
import { RefundModel, toPublicRefund } from '../models/refund.model.js';
import { IntentStateError, ProviderRejectedError, ProviderUnavailableError, type SimulatedOutcome } from '../providers/provider.js';
import type { MockPaymentProvider } from '../providers/mock.provider.js';
import type { PaymentWorkflow } from './workflow.js';

interface Ctx {
  token: string;
  requestId?: string;
}

/** 409 BILLING_PENDING: the Billing Service has not finalized the amount yet (retry shortly). */
export class BillingPendingError extends AppError {
  constructor() {
    super(409, 'BILLING_PENDING', 'Billing for this order is still being finalized; please retry in a few seconds');
  }
}

const providerUnavailable = (err: Error) => new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', `Payment provider temporarily unavailable; please retry. (${err.message})`);

function mapProviderError(err: unknown): never {
  if (err instanceof ProviderUnavailableError) throw providerUnavailable(err);
  if (err instanceof ProviderRejectedError) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', err.message);
  throw err;
}

export class PaymentService {
  constructor(
    private readonly workflow: PaymentWorkflow,
    private readonly kick: () => void = () => undefined,
  ) {}

  private get provider() {
    return this.workflow.provider;
  }

  /**
   * Starts (or resumes) payment for an order. The amount is ALWAYS the Billing Service invoice's
   * finalAmount — never the client's, never the order's provisional total; the client only says
   * which order. One PaymentIntent per payment, created with the
   * idempotency key `pi:<paymentId>`, so retries and concurrent clicks reuse the same intent.
   */
  async initiate(user: AuthUser, orderId: string, ctx: Ctx) {
    void ctx;
    // Decided from local state only — no synchronous calls to the Order or Billing services.
    // customerId and expiresAt never change after order creation; closures arrive as events.
    const p = await PaymentModel.findOne({ orderId }).lean();
    if (p && p.customerId !== user.id) throw new NotFoundError('Order not found');
    if (!p || !p.invoiceId || p.amount === undefined || p.amount <= 0) {
      // order.created / billing.finalized not processed yet: explicit pending state, the client retries.
      throw new BillingPendingError();
    }

    if (CAPTURED.includes(p.status)) throw new ConflictError('This order has already been paid', 'ALREADY_PAID');
    if (p.orderClosure === 'expired' || (p.expiresAt && p.expiresAt.getTime() <= Date.now())) {
      throw new ConflictError('The payment deadline for this order has passed', 'ORDER_EXPIRED');
    }
    if (p.status === 'cancelled' || p.orderCancelledAt) throw new ConflictError('This order has been cancelled', 'ORDER_NOT_PAYABLE');
    if (p.status === 'processing') throw new ConflictError('A payment for this order is already processing', 'PAYMENT_PROCESSING');

    let intent;
    let created = false;
    try {
      if (p.providerPaymentIntentId) {
        intent = await this.provider.retrievePaymentIntent(p.providerPaymentIntentId);
      } else {
        const params = {
          amount: p.amount, // invoice.finalAmount
          currency: 'INR' as const,
          description: `Food order ${p.orderNumber}`,
          metadata: { paymentId: p._id.toString(), orderId: p.orderId, orderNumber: p.orderNumber, customerId: p.customerId, invoiceId: p.invoiceId ?? '' },
        };
        // Same idempotency key on every attempt: a transient failure (or a concurrent click still in
        // flight at the provider) is retried briefly without any risk of a second PaymentIntent.
        for (let attempt = 1; ; attempt++) {
          try {
            intent = await this.provider.createPaymentIntent(params, `pi:${p._id}`);
            break;
          } catch (err) {
            if (!(err instanceof ProviderUnavailableError) || attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, 150 * attempt));
          }
        }
        created = true;
      }
    } catch (err) {
      mapProviderError(err);
    }

    if (['succeeded', 'processing', 'canceled'].includes(intent.status)) {
      // Our record lagged behind Stripe (webhook not yet received): adopt the provider's truth.
      await this.workflow.tx((s) => this.workflow.applyIntent(s, p._id, intent, `api:${user.id}`));
      throw new ConflictError(`Payment is already ${intent.status}`, intent.status === 'succeeded' ? 'ALREADY_PAID' : 'PAYMENT_PROCESSING');
    }
    if (intent.amount !== p.amount) throw new ConflictError('Provider amount does not match the invoice', 'AMOUNT_MISMATCH');

    await this.workflow.tx(async (s) => {
      const fresh = (await PaymentModel.findById(p._id).session(s).lean())!;
      if (fresh.providerPaymentIntentId && fresh.providerPaymentIntentId !== intent.id) {
        throw new ConflictError('A different payment attempt is already in progress', 'PAYMENT_IN_PROGRESS');
      }
      if (fresh.status === 'pending' || fresh.status === 'failed') {
        await this.workflow.move(s, fresh, 'requires_action', `api:${user.id}`, fresh.status === 'failed' ? 'Customer retried payment' : 'Payment initiated', {
          providerPaymentIntentId: intent.id,
        });
      } else if (!fresh.providerPaymentIntentId) {
        await PaymentModel.updateOne({ _id: fresh._id }, { $set: { providerPaymentIntentId: intent.id } }, { session: s });
      }
      await PaymentModel.updateOne({ _id: fresh._id }, { $inc: { attempts: 1 } }, { session: s });
    });

    const payment = (await PaymentModel.findById(p._id).lean())!;
    return {
      created,
      result: {
        payment: toPublicPayment(payment),
        paymentIntentId: intent.id,
        clientSecret: intent.clientSecret ?? null,
        provider: this.provider.name,
        testMode: true,
      },
    };
  }

  async get(user: AuthUser, paymentId: string) {
    const p = await PaymentModel.findById(paymentId).lean();
    return this.present(user, p);
  }

  async getByOrder(user: AuthUser, orderId: string) {
    return this.present(user, await PaymentModel.findOne({ orderId }).lean());
  }

  async list(user: AuthUser, q: { status?: PaymentStatus; orderId?: string; customerId?: string; page: number; limit: number }) {
    const filter: QueryFilter<IPayment> = {};
    if (q.status) filter.status = q.status;
    if (q.orderId) filter.orderId = q.orderId;
    if (user.role === 'customer') filter.customerId = user.id;
    else if (user.role === 'platform_admin') {
      if (q.customerId) filter.customerId = q.customerId;
    } else throw new ForbiddenError();
    const [items, total] = await Promise.all([
      PaymentModel.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      PaymentModel.countDocuments(filter),
    ]);
    return { payments: items.map(toPublicPayment), total };
  }

  /** Platform-admin refund (full or partial). Idempotency-Key makes retries safe. */
  async refund(admin: AuthUser, paymentId: string, body: { amount?: number; reason: string }, idempotencyKey: string) {
    const key = `admin:${idempotencyKey}`;
    const existing = await RefundModel.findOne({ idempotencyKey: key }).lean();
    if (existing) {
      if (existing.paymentId !== paymentId) throw new ConflictError('Idempotency-Key already used for another payment', 'IDEMPOTENCY_KEY_REUSED');
      return { refund: toPublicRefund(existing), replayed: true };
    }
    const p = await PaymentModel.findById(paymentId).lean();
    if (!p) throw new NotFoundError('Payment not found');
    if (p.status === 'refund_pending') throw new ConflictError('A refund for this payment is already in progress', 'REFUND_IN_PROGRESS');
    if (p.status !== 'succeeded' && p.status !== 'partially_refunded') {
      throw new ConflictError(`A ${p.status} payment cannot be refunded`, 'PAYMENT_NOT_REFUNDABLE');
    }
    const remaining = (p.amount ?? 0) - p.refundedAmount;
    const amount = body.amount ?? remaining;
    if (amount > remaining) {
      throw new UnprocessableError(`Refund exceeds the refundable amount (${remaining} paise)`, 'REFUND_EXCEEDS_REMAINING');
    }
    try {
      const refund = await this.workflow.tx((s) =>
        this.workflow.requestRefund(s, p, { amount, reason: body.reason, requestedBy: `admin:${admin.id}`, idempotencyKey: key }, `api:${admin.id}`),
      );
      this.kick();
      return { refund: toPublicRefund(refund), replayed: false };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const raced = await RefundModel.findOne({ idempotencyKey: key }).lean();
        if (raced) return { refund: toPublicRefund(raced), replayed: true };
      }
      throw err;
    }
  }

  /**
   * TEST ENDPOINT ONLY: plays the customer's part so payments can be completed without a frontend.
   * Stripe provider: confirms the PaymentIntent with a Stripe *test* card. Mock: simulates it.
   * The resulting state change still arrives only through a signed webhook.
   */
  async simulate(user: AuthUser, paymentId: string, outcome: SimulatedOutcome, deliveries: number) {
    const p = await PaymentModel.findById(paymentId).lean();
    if (!p || (user.role !== 'platform_admin' && p.customerId !== user.id)) throw new NotFoundError('Payment not found');
    if (!p.providerPaymentIntentId) throw new ConflictError('Initiate the payment first', 'PAYMENT_NOT_INITIATED');
    try {
      if (this.provider.name === 'mock') {
        await (this.provider as MockPaymentProvider).simulateCustomerPayment(p.providerPaymentIntentId, outcome, { deliveries });
      } else {
        await this.provider.simulateCustomerPayment(p.providerPaymentIntentId, outcome);
      }
    } catch (err) {
      if (err instanceof IntentStateError) throw new ConflictError(err.message, 'INVALID_PAYMENT_STATE');
      if (err instanceof ProviderUnavailableError) throw providerUnavailable(err);
      if (err instanceof ProviderRejectedError) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', err.message);
      throw err;
    }
    return { paymentId, outcome, provider: this.provider.name, note: 'The outcome is applied when the signed webhook arrives' };
  }

  private async present(user: AuthUser, p: IPayment | null) {
    // 404 (not 403) for other customers' payments, so existence is not revealed.
    if (!p || (user.role !== 'platform_admin' && p.customerId !== user.id)) throw new NotFoundError('Payment not found');
    const refunds = await RefundModel.find({ paymentId: p._id.toString() }).sort({ createdAt: 1 }).lean();
    return { ...toPublicPayment(p), refunds: refunds.map(toPublicRefund) };
  }
}

