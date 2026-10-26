import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { ORDER_STATUSES, PAYMENT_STATUSES, type OrderStatus, type PaymentStatus } from './order-status.js';

export interface IOrderItem {
  menuItemId: string;
  /** Snapshots taken at order time — later menu edits never change historical orders. */
  name: string;
  unitPrice: number;
  isVeg: boolean;
  quantity: number;
  lineTotal: number;
}

export interface IDeliveryAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  pincode: string;
  landmark?: string;
}

export interface IStatusChange {
  status: OrderStatus;
  at: Date;
  /** Event that caused (API actions) or recorded (event-driven) this transition. */
  sourceEventId?: string;
  sourceService?: string;
  by: string;
  role: string;
  note?: string;
  /** Non-sensitive context (e.g. agentName). Never OTPs or payment secrets. */
  metadata?: Record<string, string>;
}

export interface IPaymentUpdate {
  eventId: string;
  eventType: string;
  paymentStatus: PaymentStatus;
  at: Date;
  note?: string;
}

/** Mirror of the Billing Service's invoice (authoritative payable amount), from billing.invoice_generated. */
export interface IOrderBilling {
  invoiceId: string;
  invoiceNumber: string;
  discountCode?: string;
  discountAmount: number;
  taxAmount: number;
  finalAmount: number;
  issuedAt: Date;
}

/** Mirror of the Delivery Service's record, updated only from delivery.* events. Public details only. */
export interface IOrderDelivery {
  deliveryId: string;
  /** Delivery Service status: awaiting_partner | partner_assigned | picked_up | arrived | delivered | cancelled | assignment_failed */
  status: string;
  agent?: { id: string; name: string; phoneMasked?: string };
  otpExpiresAt?: Date;
  failureReason?: string;
  updatedAt: Date;
}

export interface IOrder {
  _id: Types.ObjectId;
  orderNumber: string;
  customerId: string;
  customerEmail: string;
  customerName: string;
  restaurantId: string;
  restaurantName: string;
  items: IOrderItem[];
  /** All amounts are integer paise. */
  subtotal: number;
  deliveryFee: number;
  /** subtotal + deliveryFee. Taxes/discounts are applied later by the Billing Service. */
  provisionalTotal: number;
  currency: 'INR';
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  statusHistory: IStatusChange[];
  /** Payment Service's id for this order's payment (set from payment events). */
  paymentId?: string;
  /** Amount captured (verified against the Billing invoice) when the order was confirmed. */
  amountPaid?: number;
  /** Append-only log of payment events applied to this order. */
  paymentHistory: IPaymentUpdate[];
  deliveryAddress: IDeliveryAddress;
  delivery?: IOrderDelivery;
  notes?: string;
  cancellation?: { reason: string; by: string; role: string; at: Date };
  discountCode?: string;
  billing?: IOrderBilling;
  /** Payment deadline: an order still unpaid at this time is marked `expired` (never deleted). */
  expiresAt?: Date;
  expiredAt?: Date;
  /** Client-supplied Idempotency-Key, unique per customer, so retried POSTs never create duplicates. */
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    menuItemId: { type: String, required: true },
    name: { type: String, required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    isVeg: { type: Boolean, required: true },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true },
    customerId: { type: String, required: true },
    customerEmail: { type: String, required: true },
    customerName: { type: String, required: true },
    restaurantId: { type: String, required: true },
    restaurantName: { type: String, required: true },
    items: { type: [orderItemSchema], required: true, validate: (v: unknown[]) => v.length > 0 },
    subtotal: { type: Number, required: true, min: 0 },
    deliveryFee: { type: Number, required: true, min: 0 },
    provisionalTotal: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    status: { type: String, enum: ORDER_STATUSES, required: true, default: 'pending_payment' },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, required: true, default: 'pending' },
    statusHistory: [
      {
        _id: false,
        status: { type: String, enum: ORDER_STATUSES, required: true },
        at: { type: Date, required: true },
        sourceEventId: String,
        sourceService: String,
        by: { type: String, required: true },
        role: { type: String, required: true },
        note: String,
        metadata: { type: Schema.Types.Mixed, default: undefined },
      },
    ],
    paymentId: String,
    amountPaid: Number,
    delivery: { type: Schema.Types.Mixed, default: undefined },
    paymentHistory: [
      {
        _id: false,
        eventId: { type: String, required: true },
        eventType: { type: String, required: true },
        paymentStatus: { type: String, enum: PAYMENT_STATUSES, required: true },
        at: { type: Date, required: true },
        note: String,
      },
    ],
    deliveryAddress: {
      line1: { type: String, required: true },
      line2: String,
      city: { type: String, required: true },
      state: String,
      pincode: { type: String, required: true },
      landmark: String,
    },
    notes: String,
    cancellation: { reason: String, by: String, role: String, at: Date },
    expiresAt: Date,
    expiredAt: Date,
    discountCode: String,
    billing: {
      type: new Schema<IOrderBilling>(
        {
          invoiceId: { type: String, required: true },
          invoiceNumber: { type: String, required: true },
          discountCode: String,
          discountAmount: { type: Number, required: true },
          taxAmount: { type: Number, required: true },
          finalAmount: { type: Number, required: true },
          issuedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    idempotencyKey: String,
  },
  { timestamps: true, versionKey: false },
);

orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
// Expiration worker: unpaid orders past their deadline. (A query index — NOT a TTL index: orders are never deleted.)
orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index(
  { customerId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export type OrderDocument = HydratedDocument<IOrder>;
export const OrderModel = model<IOrder>('Order', orderSchema);

export function toPublicOrder(o: IOrder) {
  return {
    id: o._id.toString(),
    orderNumber: o.orderNumber,
    customerId: o.customerId,
    restaurantId: o.restaurantId,
    restaurantName: o.restaurantName,
    items: o.items.map((i) => ({
      menuItemId: i.menuItemId,
      name: i.name,
      unitPrice: i.unitPrice,
      isVeg: i.isVeg,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
    })),
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    provisionalTotal: o.provisionalTotal,
    currency: o.currency,
    status: o.status,
    paymentStatus: o.paymentStatus,
    statusHistory: o.statusHistory.map((h) => ({
      status: h.status,
      at: h.at,
      sourceEventId: h.sourceEventId ?? null,
      sourceService: h.sourceService ?? null,
      by: h.by,
      role: h.role,
      note: h.note,
      metadata: h.metadata ?? {},
    })),
    paymentId: o.paymentId ?? null,
    amountPaid: o.amountPaid ?? null,
    paymentHistory: (o.paymentHistory ?? []).map((p) => ({ eventType: p.eventType, paymentStatus: p.paymentStatus, at: p.at, note: p.note })),
    deliveryAddress: o.deliveryAddress,
    delivery: o.delivery
      ? { deliveryId: o.delivery.deliveryId, status: o.delivery.status, agent: o.delivery.agent ?? null, otpExpiresAt: o.delivery.otpExpiresAt ?? null, failureReason: o.delivery.failureReason ?? null, updatedAt: o.delivery.updatedAt }
      : null,
    notes: o.notes ?? null,
    cancellation: o.cancellation?.reason ? o.cancellation : null,
    discountCode: o.discountCode ?? null,
    /** Final payable amount from the Billing Service (null until the invoice is issued). */
    billing: o.billing
      ? {
          invoiceId: o.billing.invoiceId,
          invoiceNumber: o.billing.invoiceNumber,
          discountCode: o.billing.discountCode ?? null,
          discountAmount: o.billing.discountAmount,
          taxAmount: o.billing.taxAmount,
          finalAmount: o.billing.finalAmount,
          issuedAt: o.billing.issuedAt,
        }
      : null,
    expiresAt: o.expiresAt ?? null,
    expiredAt: o.expiredAt ?? null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
