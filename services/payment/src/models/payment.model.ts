import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { PAYMENT_STATUSES, REFUND_STATUSES, type PaymentStatus, type RefundStatusSummary } from './payment-status.js';

export interface IPaymentStatusChange {
  status: PaymentStatus;
  at: Date;
  /** What caused it: `webhook:evt_…`, `event:<eventId>`, `api:<userId>`, `reconciler`. */
  source: string;
  note?: string;
}

export interface IPayment {
  _id: Types.ObjectId;
  orderId: string;
  orderNumber: string;
  customerId: string;
  /**
   * Integer minor units (paise): the Billing Service invoice's finalAmount — never the client's,
   * never the order's provisional total. Unset until the invoice is known.
   */
  amount?: number;
  invoiceId?: string;
  invoiceNumber?: string;
  currency: 'INR';
  status: PaymentStatus;
  refundStatus: RefundStatusSummary;
  refundedAmount: number;
  provider: 'stripe' | 'mock';
  providerPaymentIntentId?: string;
  /** Number of times the customer initiated / retried this payment. */
  attempts: number;
  lastFailure?: { code?: string; message: string; at: Date };
  paidAt?: Date;
  /**
   * Set once the order is closed without needing this payment — order.cancelled or order.expired.
   * Drives automatic PaymentIntent cancellation / refund. (Name kept from Stage 4 for compatibility.)
   */
  orderCancelledAt?: Date;
  orderCancelReason?: string;
  /** Why the order was closed. */
  orderClosure?: 'cancelled' | 'expired';
  /** Payment deadline copied from the order; initiation is refused after it. */
  expiresAt?: Date;
  /** Background work scheduling (PaymentIntent cancellation retries, provider polling). */
  reconcile: { attempts: number; nextAttemptAt?: Date; lastError?: string };
  statusHistory: IPaymentStatusChange[];
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    orderId: { type: String, required: true, unique: true },
    orderNumber: { type: String, required: true },
    customerId: { type: String, required: true },
    amount: { type: Number, min: 0, validate: { validator: Number.isInteger, message: 'amount must be integer paise' } },
    invoiceId: String,
    invoiceNumber: String,
    currency: { type: String, enum: ['INR'], default: 'INR' },
    status: { type: String, enum: PAYMENT_STATUSES, required: true, default: 'pending' },
    refundStatus: { type: String, enum: REFUND_STATUSES, default: 'none' },
    refundedAmount: { type: Number, default: 0, min: 0 },
    provider: { type: String, enum: ['stripe', 'mock'], required: true },
    providerPaymentIntentId: { type: String },
    attempts: { type: Number, default: 0 },
    lastFailure: { code: String, message: String, at: Date },
    paidAt: Date,
    orderCancelledAt: Date,
    orderCancelReason: String,
    orderClosure: { type: String, enum: ['cancelled', 'expired'] },
    expiresAt: Date,
    reconcile: {
      attempts: { type: Number, default: 0 },
      nextAttemptAt: Date,
      lastError: String,
    },
    statusHistory: [
      {
        _id: false,
        status: { type: String, enum: PAYMENT_STATUSES, required: true },
        at: { type: Date, required: true },
        source: { type: String, required: true },
        note: String,
      },
    ],
  },
  { timestamps: true, versionKey: false },
);

paymentSchema.index({ providerPaymentIntentId: 1 }, { unique: true, partialFilterExpression: { providerPaymentIntentId: { $type: 'string' } } });
paymentSchema.index({ customerId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, 'reconcile.nextAttemptAt': 1 });

export type PaymentDocument = HydratedDocument<IPayment>;
export const PaymentModel = model<IPayment>('Payment', paymentSchema);

export function toPublicPayment(p: IPayment) {
  return {
    id: p._id.toString(),
    orderId: p.orderId,
    orderNumber: p.orderNumber,
    customerId: p.customerId,
    amount: p.amount ?? null,
    invoiceId: p.invoiceId ?? null,
    invoiceNumber: p.invoiceNumber ?? null,
    currency: p.currency,
    status: p.status,
    refundStatus: p.refundStatus,
    refundedAmount: p.refundedAmount,
    provider: p.provider,
    providerPaymentIntentId: p.providerPaymentIntentId ?? null,
    attempts: p.attempts,
    lastFailure: p.lastFailure?.message ? { code: p.lastFailure.code ?? null, message: p.lastFailure.message, at: p.lastFailure.at } : null,
    paidAt: p.paidAt ?? null,
    orderCancelledAt: p.orderCancelledAt ?? null,
    orderClosure: p.orderClosure ?? null,
    expiresAt: p.expiresAt ?? null,
    statusHistory: p.statusHistory.map((h) => ({ status: h.status, at: h.at, source: h.source, note: h.note })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
