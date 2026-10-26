import { Schema, model, type Types } from 'mongoose';
import { immutablePlugin } from './immutable.js';

export interface IInvoiceLine {
  kind: 'item' | 'delivery_fee';
  description: string;
  menuItemId?: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

/** Reserved for taxes later (GST etc.): empty today, so taxAmount = 0. */
export interface ITaxLine {
  name: string;
  /** basis points, e.g. 500 = 5% */
  rateBps: number;
  base: number;
  amount: number;
}

export interface IInvoiceDiscount {
  code: string;
  description: string;
  type: 'percent' | 'flat';
  value: number;
  amount: number;
}

export interface IInvoice {
  _id: Types.ObjectId;
  invoiceNumber: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  currency: 'INR';
  lines: IInvoiceLine[];
  /** Σ item lines. */
  itemsSubtotal: number;
  deliveryFee: number;
  /** itemsSubtotal + deliveryFee. */
  subtotal: number;
  discount?: IInvoiceDiscount;
  /** Why a requested code was not applied (unknown, expired, minimum not met, …). */
  discountRejection?: { code: string; reason: string };
  discountAmount: number;
  taxLines: ITaxLine[];
  taxAmount: number;
  /** subtotal − discountAmount + taxAmount: the only amount that may be charged. */
  finalAmount: number;
  /** Bump when the calculation rules change (e.g. when taxes are introduced). */
  schemaVersion: number;
  /** `event:<eventId>` or `api:<userId>`. */
  issuedFrom: string;
  /** The order's payment deadline, copied from order.created (informational, carried on billing.finalized). */
  orderExpiresAt?: Date;
  issuedAt: Date;
}

const money = { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'integer paise' } };

const invoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    // One invoice per order, enforced by the database.
    orderId: { type: String, required: true, unique: true },
    orderNumber: { type: String, required: true },
    customerId: { type: String, required: true, index: true },
    restaurantId: { type: String, required: true },
    restaurantName: { type: String, required: true },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    lines: [
      {
        _id: false,
        kind: { type: String, enum: ['item', 'delivery_fee'], required: true },
        description: { type: String, required: true },
        menuItemId: String,
        unitPrice: money,
        quantity: { type: Number, required: true, min: 1 },
        lineTotal: money,
      },
    ],
    itemsSubtotal: money,
    deliveryFee: money,
    subtotal: money,
    discount: { type: new Schema({ code: String, description: String, type: String, value: Number, amount: Number }, { _id: false }), default: undefined },
    discountRejection: { type: new Schema({ code: String, reason: String }, { _id: false }), default: undefined },
    discountAmount: money,
    taxLines: [{ _id: false, name: String, rateBps: Number, base: Number, amount: Number }],
    taxAmount: money,
    finalAmount: money,
    schemaVersion: { type: Number, required: true },
    issuedFrom: { type: String, required: true },
    orderExpiresAt: Date,
    issuedAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'invoices' },
);
immutablePlugin(invoiceSchema, 'Invoice');

export const InvoiceModel = model<IInvoice>('Invoice', invoiceSchema);
