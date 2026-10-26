import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const OTP_STATUSES = ['active', 'consumed', 'superseded', 'expired', 'locked', 'cancelled'] as const;
export type OtpStatus = (typeof OTP_STATUSES)[number];

/**
 * One issued delivery OTP. Only a keyed verifier (HMAC-SHA256 over delivery id, sequence and code) is
 * stored — never the code. The code is generated, sealed for the Notification Service and hashed in
 * memory inside the arrival transaction, then discarded.
 */
export interface IOtp {
  _id: Types.ObjectId;
  deliveryId: string;
  sequence: number;
  verifier: string;
  status: OtpStatus;
  attempts: number;
  maxAttempts: number;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  /** Outbox id of the restricted notification command that carries the sealed code. */
  notificationEventId: string;
}

const otpSchema = new Schema<IOtp>(
  {
    deliveryId: { type: String, required: true },
    sequence: { type: Number, required: true },
    verifier: { type: String, required: true, select: false },
    status: { type: String, enum: OTP_STATUSES, default: 'active' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: Date,
    notificationEventId: { type: String, required: true },
  },
  { versionKey: false, collection: 'delivery_otps' },
);
otpSchema.index({ deliveryId: 1, sequence: 1 }, { unique: true });
// At most one usable OTP per delivery.
otpSchema.index({ deliveryId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

export const OtpModel = (mongoose.models.DeliveryOtp as Model<IOtp> | undefined) ?? mongoose.model<IOtp>('DeliveryOtp', otpSchema);
