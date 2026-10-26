import { Schema, model, type Types } from 'mongoose';

export const NOTIFICATION_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Non-sensitive data needed to render the email (re-rendered on every attempt; bodies are not stored). */
export interface NotificationContext {
  orderNumber: string;
  customerName: string;
  status: string;
  previousStatus: string | null;
  changedAt: string;
  reason?: string;
  summary: {
    restaurantName: string;
    items: { name: string; quantity: number; lineTotal: number }[];
    currency: 'INR';
    total: number;
    amountPaid?: number;
    deliveryCity: string;
  };
  metadata: Record<string, string>;
}

/** Context of a delivery-code email. The code itself is never part of it. */
export interface OtpContext {
  orderNumber: string;
  customerName: string;
  agentName: string;
  deliveryId: string;
  otpSequence: number;
  otpExpiresAt: string;
}

export interface INotification {
  _id: Types.ObjectId;
  /** Business-level idempotency: one email per (order, status) however many events describe it. */
  dedupeKey: string;
  sourceEventId: string;
  eventType: string;
  orderId: string;
  customerId: string;
  recipient: string;
  channel: 'email';
  template: string;
  context: NotificationContext | OtpContext;
  /**
   * Restricted notifications only: the code sealed to this service's key (opened in memory at send time)
   * and the moment after which it is worthless. Removed as soon as the email is sent or abandoned.
   */
  secretCiphertext?: string;
  notAfter?: Date;
  status: NotificationStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  /** Set while an attempt is in flight; an expired lease means the attempt was lost (crash). */
  leaseUntil?: Date;
  lastError?: string;
  failures: { at: Date; error: string }[];
  smtpMessageId?: string;
  smtpResponse?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    dedupeKey: { type: String, required: true, unique: true },
    sourceEventId: { type: String, required: true },
    eventType: { type: String, required: true },
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true },
    recipient: { type: String, required: true },
    channel: { type: String, enum: ['email'], default: 'email' },
    template: { type: String, required: true },
    context: { type: Schema.Types.Mixed, required: true },
    secretCiphertext: { type: String, select: false },
    notAfter: Date,
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    nextAttemptAt: { type: Date, default: () => new Date() },
    leaseUntil: Date,
    lastError: String,
    failures: [{ _id: false, at: Date, error: String }],
    smtpMessageId: String,
    smtpResponse: String,
    sentAt: Date,
  },
  { timestamps: true, versionKey: false, collection: 'notifications', minimize: false },
);
notificationSchema.index({ status: 1, nextAttemptAt: 1 });

export const NotificationModel = model<INotification>('Notification', notificationSchema);
