import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const REFUND_RECORD_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type RefundRecordStatus = (typeof REFUND_RECORD_STATUSES)[number];

export interface IRefund {
  _id: Types.ObjectId;
  paymentId: string;
  orderId: string;
  customerId: string;
  amount: number;
  reason: string;
  /** `system:order-cancelled`, `system:order-expired` or `admin:<userId>`. */
  requestedBy: string;
  /**
   * Unique: at most one refund per key. Automatic cancellation refunds use `order-cancelled:<paymentId>`,
   * so repeated cancellation events can never refund twice; admin refunds use the client's Idempotency-Key.
   */
  idempotencyKey: string;
  status: RefundRecordStatus;
  providerRefundId?: string;
  failure?: { code?: string; message: string };
  /** Submission retries (transient provider errors). */
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  submittedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const refundSchema = new Schema<IRefund>(
  {
    paymentId: { type: String, required: true, index: true },
    orderId: { type: String, required: true },
    customerId: { type: String, required: true },
    amount: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'amount must be integer paise' } },
    reason: { type: String, required: true },
    requestedBy: { type: String, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    status: { type: String, enum: REFUND_RECORD_STATUSES, default: 'pending' },
    providerRefundId: String,
    failure: { code: String, message: String },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError: String,
    submittedAt: Date,
    completedAt: Date,
  },
  { timestamps: true, versionKey: false },
);

refundSchema.index({ providerRefundId: 1 }, { unique: true, partialFilterExpression: { providerRefundId: { $type: 'string' } } });
refundSchema.index({ status: 1, nextAttemptAt: 1 });

export type RefundDocument = HydratedDocument<IRefund>;
export const RefundModel = model<IRefund>('Refund', refundSchema);

export function toPublicRefund(r: IRefund) {
  return {
    id: r._id.toString(),
    paymentId: r.paymentId,
    orderId: r.orderId,
    amount: r.amount,
    reason: r.reason,
    requestedBy: r.requestedBy,
    status: r.status,
    providerRefundId: r.providerRefundId ?? null,
    failure: r.failure?.message ? r.failure : null,
    createdAt: r.createdAt,
    completedAt: r.completedAt ?? null,
  };
}
