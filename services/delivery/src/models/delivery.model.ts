import mongoose, { Schema, type Model, type Types } from 'mongoose';
import { DELIVERY_STATUSES } from '@food/common';

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Statuses in which a delivery is still in progress (cancellable, agent possibly reserved). */
export const ACTIVE_STATUSES: DeliveryStatus[] = ['preparing', 'awaiting_partner', 'partner_assigned', 'picked_up', 'arrived', 'assignment_failed'];

export interface IDelivery {
  _id: Types.ObjectId;
  /** One delivery per order (unique). Also used for tombstones when a cancellation arrives first. */
  orderId: string;
  orderNumber?: string;
  customerId?: string;
  /** Only for addressing the OTP command; never returned by the API. */
  customerEmail?: string;
  customerName?: string;
  restaurantId?: string;
  restaurantName?: string;
  deliveryAddress?: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
  items: { name: string; quantity: number }[];
  status: DeliveryStatus;
  /** order.confirmed event that created it (or the cancellation that tombstoned it). */
  sourceEventId: string;
  /** Created from a cancellation/expiry that arrived before (or instead of) the confirmation. */
  tombstone: boolean;

  /** Persisted deadlines: the scheduler resumes from these after a restart. */
  prepareReadyAt?: Date;
  nextAssignAt?: Date;
  assignmentDeadline?: Date;
  assignmentAttempts: number;

  agentId?: string;
  agentName?: string;
  agentPhoneMasked?: string;

  readyAt?: Date;
  assignedAt?: Date;
  pickedUpAt?: Date;
  arrivedAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
  cancellation?: { reason: string; previousStatus: DeliveryStatus };
  failureReason?: string;
  /** Number of OTPs issued (first + reissues). */
  otpIssues: number;
  lastOtpIssuedAt?: Date;
  history: { status: DeliveryStatus; at: Date; by: string; note?: string }[];
  createdAt: Date;
  updatedAt: Date;
}

const deliverySchema = new Schema<IDelivery>(
  {
    orderId: { type: String, required: true, unique: true },
    orderNumber: String,
    customerId: String,
    customerEmail: String,
    customerName: String,
    restaurantId: String,
    restaurantName: String,
    deliveryAddress: { type: Schema.Types.Mixed },
    items: [{ _id: false, name: String, quantity: Number }],
    status: { type: String, enum: DELIVERY_STATUSES, required: true },
    sourceEventId: { type: String, required: true },
    tombstone: { type: Boolean, default: false },
    prepareReadyAt: Date,
    nextAssignAt: Date,
    assignmentDeadline: Date,
    assignmentAttempts: { type: Number, default: 0 },
    agentId: String,
    agentName: String,
    agentPhoneMasked: String,
    readyAt: Date,
    assignedAt: Date,
    pickedUpAt: Date,
    arrivedAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    cancellation: { type: Schema.Types.Mixed },
    failureReason: String,
    otpIssues: { type: Number, default: 0 },
    lastOtpIssuedAt: Date,
    history: [{ _id: false, status: String, at: Date, by: String, note: String }],
  },
  { timestamps: true, versionKey: false, collection: 'deliveries', minimize: false },
);
deliverySchema.index({ status: 1, prepareReadyAt: 1 });
deliverySchema.index({ status: 1, nextAssignAt: 1 });
deliverySchema.index({ agentId: 1, status: 1 });

export const DeliveryModel =
  (mongoose.models.Delivery as Model<IDelivery> | undefined) ?? mongoose.model<IDelivery>('Delivery', deliverySchema);

/** Agent-facing view: what a partner needs to deliver. No customer email, no OTP data beyond its state. */
export function toAgentView(d: IDelivery, otp?: { expiresAt: Date; attempts: number; maxAttempts: number; status: string } | null) {
  return {
    id: d._id.toString(),
    orderId: d.orderId,
    orderNumber: d.orderNumber ?? null,
    status: d.status,
    restaurantName: d.restaurantName ?? null,
    customerName: d.customerName ?? null,
    deliveryAddress: d.deliveryAddress ?? null,
    items: d.items ?? [],
    agent: d.agentId ? { id: d.agentId, name: d.agentName ?? null, phoneMasked: d.agentPhoneMasked ?? null } : null,
    timestamps: {
      createdAt: d.createdAt,
      prepareReadyAt: d.prepareReadyAt ?? null,
      readyAt: d.readyAt ?? null,
      assignedAt: d.assignedAt ?? null,
      pickedUpAt: d.pickedUpAt ?? null,
      arrivedAt: d.arrivedAt ?? null,
      deliveredAt: d.deliveredAt ?? null,
      cancelledAt: d.cancelledAt ?? null,
    },
    assignmentAttempts: d.assignmentAttempts,
    failureReason: d.failureReason ?? null,
    cancellation: d.cancellation ?? null,
    otp: otp
      ? { status: otp.status, expiresAt: otp.expiresAt, attemptsRemaining: Math.max(0, otp.maxAttempts - otp.attempts) }
      : null,
    otpIssues: d.otpIssues,
    history: d.history,
  };
}
