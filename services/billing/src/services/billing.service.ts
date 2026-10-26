import { randomInt } from 'node:crypto';
import type { ClientSession, QueryFilter } from 'mongoose';
import {
  ConflictError,
  enqueueEvent,
  EventTypes,
  ForbiddenError,
  NotFoundError,
  type AuthUser,
  type EventData,
  type Logger,
} from '@food/common';
import { DiscountModel, toPublicDiscount, type IDiscount } from '../models/discount.model.js';
import { BillingEntryModel, type EntryKind, type IBillingEntry } from '../models/entry.model.js';
import { InvoiceModel, type IInvoice } from '../models/invoice.model.js';
import { CALCULATION_VERSION, computeInvoice, type BillableOrder } from './calculator.js';

export const SERVICE_NAME = 'billing-service';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const docNumber = (prefix: string, at = new Date()) =>
  `${prefix}-${at.toISOString().slice(2, 10).replaceAll('-', '')}-${Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

export type InvoiceStatus = 'open' | 'paid' | 'partially_refunded' | 'refunded' | 'void';

/** Derives the invoice's state from the immutable ledger (the invoice itself never changes). */
export function deriveState(invoice: IInvoice, entries: IBillingEntry[]) {
  const sum = (k: EntryKind) => entries.filter((e) => e.kind === k).reduce((s, e) => s + e.amount, 0);
  const paid = sum('payment');
  const refunded = sum('refund') - sum('refund_reversal');
  const closed = entries.some((e) => e.kind === 'closure');
  let status: InvoiceStatus;
  if (paid === 0) status = closed ? 'void' : 'open';
  else if (refunded <= 0) status = 'paid';
  else if (refunded < paid) status = 'partially_refunded';
  else status = 'refunded';
  return { status, amountPaid: paid, amountRefunded: Math.max(refunded, 0), netCollected: paid - Math.max(refunded, 0), amountDue: status === 'open' ? invoice.finalAmount : 0 };
}

export function toPublicInvoice(i: IInvoice, entries: IBillingEntry[]) {
  return {
    id: i._id.toString(),
    invoiceNumber: i.invoiceNumber,
    orderId: i.orderId,
    orderNumber: i.orderNumber,
    customerId: i.customerId,
    restaurantId: i.restaurantId,
    restaurantName: i.restaurantName,
    currency: i.currency,
    lines: i.lines,
    itemsSubtotal: i.itemsSubtotal,
    deliveryFee: i.deliveryFee,
    subtotal: i.subtotal,
    discount: i.discount ?? null,
    discountRejection: i.discountRejection ?? null,
    discountAmount: i.discountAmount,
    taxLines: i.taxLines,
    taxAmount: i.taxAmount,
    finalAmount: i.finalAmount,
    schemaVersion: i.schemaVersion,
    issuedAt: i.issuedAt,
    ...deriveState(i, entries),
    adjustments: entries.map((e) => ({
      kind: e.kind,
      amount: e.amount,
      reference: e.reference,
      reason: e.reason,
      documentNumber: e.documentNumber ?? null,
      anomaly: e.anomaly ?? null,
      at: e.createdAt,
    })),
  };
}

export class BillingService {
  constructor(
    private readonly logger: Logger,
    private readonly opts: { minPayable: number },
    private readonly afterCommit: () => void = () => undefined,
  ) {}

  notify() {
    this.afterCommit();
  }

  // ================================================================ invoices

  /**
   * Issues the invoice for an order — exactly once (unique orderId). Returns the existing invoice if
   * one was already issued (event redelivery, or REST issue-on-demand racing the event).
   * Throws SubtotalMismatchError if the order's figures don't add up.
   */
  async issueInvoice(session: ClientSession, order: BillableOrder, issuedFrom: string): Promise<{ invoice: IInvoice; created: boolean }> {
    const existing = await InvoiceModel.findOne({ orderId: order.orderId }).session(session).lean();
    if (existing) return { invoice: existing, created: false };

    const discount: IDiscount | null = order.discountCode ? await DiscountModel.findOne({ code: order.discountCode }).session(session).lean() : null;
    const now = new Date();
    const totals = computeInvoice(order, discount, { minPayable: this.opts.minPayable, now });
    const [doc] = await InvoiceModel.create(
      [
        {
          invoiceNumber: docNumber('INV', now),
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          restaurantId: order.restaurantId,
          restaurantName: order.restaurantName,
          currency: 'INR',
          ...totals,
          schemaVersion: CALCULATION_VERSION,
          issuedFrom,
          ...(order.expiresAt ? { orderExpiresAt: new Date(order.expiresAt) } : {}),
          issuedAt: now,
        },
      ],
      { session },
    );
    const invoice = doc!.toObject();
    await enqueueEvent(session, {
      source: SERVICE_NAME,
      eventType: EventTypes.BillingFinalized,
      aggregateId: invoice.orderId,
      data: {
        invoiceId: invoice._id.toString(),
        invoiceNumber: invoice.invoiceNumber,
        invoiceVersion: invoice.schemaVersion,
        orderId: invoice.orderId,
        orderNumber: invoice.orderNumber,
        customerId: invoice.customerId,
        currency: 'INR',
        itemsSubtotal: invoice.itemsSubtotal,
        deliveryFee: invoice.deliveryFee,
        subtotal: invoice.subtotal,
        ...(invoice.discount ? { discountCode: invoice.discount.code } : {}),
        discountAmount: invoice.discountAmount,
        taxAmount: invoice.taxAmount,
        finalAmount: invoice.finalAmount,
        ...(invoice.orderExpiresAt ? { expiresAt: invoice.orderExpiresAt.toISOString() } : {}),
        issuedAt: invoice.issuedAt.toISOString(),
      },
    });
    if (totals.discountRejection) this.logger.info({ orderId: order.orderId, ...totals.discountRejection }, 'Discount code not applied');
    return { invoice, created: true };
  }

  async getByOrder(user: AuthUser, orderId: string) {
    return this.present(user, await InvoiceModel.findOne({ orderId }).lean());
  }

  async get(user: AuthUser, id: string) {
    return this.present(user, await InvoiceModel.findById(id).lean());
  }

  async list(user: AuthUser, q: { orderId?: string; customerId?: string; page: number; limit: number }) {
    const filter: QueryFilter<IInvoice> = {};
    if (q.orderId) filter.orderId = q.orderId;
    if (user.role === 'customer') filter.customerId = user.id;
    else if (user.role === 'platform_admin') {
      if (q.customerId) filter.customerId = q.customerId;
    } else throw new ForbiddenError();
    const [items, total] = await Promise.all([
      InvoiceModel.find(filter).sort({ issuedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      InvoiceModel.countDocuments(filter),
    ]);
    const entries = await BillingEntryModel.find({ orderId: { $in: items.map((i) => i.orderId) } }).sort({ createdAt: 1 }).lean();
    return { invoices: items.map((i) => toPublicInvoice(i, entries.filter((e) => e.orderId === i.orderId))), total };
  }

  private async present(user: AuthUser, invoice: IInvoice | null) {
    if (!invoice || (user.role !== 'platform_admin' && invoice.customerId !== user.id)) throw new NotFoundError('Invoice not found');
    return toPublicInvoice(invoice, await this.entries(invoice.orderId));
  }

  private entries(orderId: string) {
    return BillingEntryModel.find({ orderId }).sort({ createdAt: 1 }).lean();
  }

  // ================================================================ ledger (adjustments)

  /** Appends a ledger entry once per (kind, reference); returns false if it already existed. */
  async recordEntry(session: ClientSession, e: Omit<IBillingEntry, '_id' | 'createdAt'>): Promise<boolean> {
    if (await BillingEntryModel.exists({ kind: e.kind, reference: e.reference }).session(session)) return false;
    await BillingEntryModel.create([{ ...e, createdAt: new Date() }], { session });
    return true;
  }

  async onPaymentSucceeded(session: ClientSession, d: EventData<typeof EventTypes.PaymentSucceeded>, eventId: string) {
    const invoice = await InvoiceModel.findOne({ orderId: d.orderId }).session(session).lean();
    let anomaly: string | undefined;
    if (!invoice) anomaly = 'payment recorded before invoice';
    else if (d.amount !== invoice.finalAmount) anomaly = `amount ${d.amount} ≠ invoice finalAmount ${invoice.finalAmount}`;
    else if (d.invoiceId && d.invoiceId !== invoice._id.toString()) anomaly = `charged invoice ${d.invoiceId} ≠ ${invoice._id}`;
    if (anomaly) this.logger.error({ orderId: d.orderId, paymentId: d.paymentId, anomaly }, 'Payment does not match the invoice');
    await this.recordEntry(session, { orderId: d.orderId, kind: 'payment', reference: d.paymentId, amount: d.amount, reason: `Payment via ${d.provider} (${d.providerReference})`, anomaly, sourceEventId: eventId });
  }

  async onRefundCompleted(session: ClientSession, d: EventData<typeof EventTypes.RefundCompleted>, eventId: string) {
    await this.recordEntry(session, {
      orderId: d.orderId,
      kind: 'refund',
      reference: d.refundId,
      amount: d.amount,
      reason: d.fullyRefunded ? 'Full refund' : 'Partial refund',
      documentNumber: docNumber('CN'),
      sourceEventId: eventId,
    });
  }

  /** A refund Stripe reported as succeeded and later failed: reverse its credit note. */
  async onRefundFailed(session: ClientSession, d: EventData<typeof EventTypes.RefundFailed>, eventId: string) {
    if (!(await BillingEntryModel.exists({ kind: 'refund', reference: d.refundId }).session(session))) return; // never credited
    await this.recordEntry(session, { orderId: d.orderId, kind: 'refund_reversal', reference: d.refundId, amount: d.amount, reason: `Refund failed: ${d.reason}`, sourceEventId: eventId });
  }

  /** order.cancelled / order.expired: voids an unpaid invoice (one closure per order, whichever comes first). */
  async onOrderClosed(session: ClientSession, orderId: string, reason: string, eventId: string) {
    await this.recordEntry(session, { orderId, kind: 'closure', reference: orderId, amount: 0, reason, sourceEventId: eventId });
  }

  // ================================================================ discounts

  async listDiscounts(includeInactive: boolean) {
    const now = new Date();
    const filter = includeInactive ? {} : { active: true, $or: [{ validUntil: { $exists: false } }, { validUntil: { $gte: now } }] };
    return (await DiscountModel.find(filter).sort({ code: 1 }).lean()).map(toPublicDiscount);
  }

  async createDiscount(input: Omit<IDiscount, 'createdAt' | 'updatedAt'>) {
    try {
      return toPublicDiscount((await DiscountModel.create(input)).toObject());
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('A discount with this code already exists', 'DISCOUNT_EXISTS');
      throw err;
    }
  }

  async setDiscountActive(code: string, active: boolean) {
    const d = await DiscountModel.findOneAndUpdate({ code: code.toUpperCase() }, { $set: { active } }, { returnDocument: 'after' }).lean();
    if (!d) throw new NotFoundError('Discount not found');
    return toPublicDiscount(d);
  }
}
