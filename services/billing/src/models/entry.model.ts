import { Schema, model, type Types } from 'mongoose';
import { immutablePlugin } from './immutable.js';

/**
 * Append-only billing ledger. Keyed by orderId (not invoiceId) so entries can be recorded in any
 * arrival order, even before the invoice exists.
 * - payment          +amount   payment.succeeded              reference = paymentId
 * - refund           −amount   payment.refund.completed       reference = refundId (credit note)
 * - refund_reversal  +amount   payment.refund.failed after a completed refund   reference = refundId
 * - closure          0         order.cancelled / order.expired (voids an unpaid invoice)   reference = orderId
 */
export const ENTRY_KINDS = ['payment', 'refund', 'refund_reversal', 'closure'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface IBillingEntry {
  _id: Types.ObjectId;
  orderId: string;
  kind: EntryKind;
  /** paymentId / refundId / orderId; unique together with kind, so duplicates are impossible. */
  reference: string;
  amount: number;
  reason: string;
  /** Credit note number for refunds (CN-…). */
  documentNumber?: string;
  /** Set when the recorded amount disagrees with the invoice (needs investigation). */
  anomaly?: string;
  sourceEventId: string;
  createdAt: Date;
}

const entrySchema = new Schema<IBillingEntry>(
  {
    orderId: { type: String, required: true, index: true },
    kind: { type: String, enum: ENTRY_KINDS, required: true },
    reference: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true },
    documentNumber: String,
    anomaly: String,
    sourceEventId: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'billing_entries' },
);
entrySchema.index({ kind: 1, reference: 1 }, { unique: true });
immutablePlugin(entrySchema, 'Billing entry');

export const BillingEntryModel = model<IBillingEntry>('BillingEntry', entrySchema);
