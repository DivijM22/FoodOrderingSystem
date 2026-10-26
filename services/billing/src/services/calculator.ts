import type { IDiscount } from '../models/discount.model.js';
import type { IInvoiceDiscount, IInvoiceLine, ITaxLine } from '../models/invoice.model.js';

/** What billing needs from an order (identical from order.created.v1 or the Order Service REST view). */
export interface BillableOrder {
  orderId: string;
  orderNumber: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  items: { menuItemId: string; name: string; unitPrice: number; quantity: number; lineTotal: number }[];
  /** Order Service's item subtotal (verified, not trusted). */
  subtotal: number;
  deliveryFee: number;
  provisionalTotal: number;
  discountCode?: string;
  /** The order's payment deadline (passed on so Payment needs no call to the Order Service). */
  expiresAt?: string;
}

export class SubtotalMismatchError extends Error {
  constructor(readonly problems: string[]) {
    super(`Order totals do not add up: ${problems.join('; ')}`);
    this.name = 'SubtotalMismatchError';
  }
}

export interface InvoiceTotals {
  lines: IInvoiceLine[];
  itemsSubtotal: number;
  deliveryFee: number;
  subtotal: number;
  discount?: IInvoiceDiscount;
  discountRejection?: { code: string; reason: string };
  discountAmount: number;
  taxLines: ITaxLine[];
  taxAmount: number;
  finalAmount: number;
}

export const CALCULATION_VERSION = 1;

const isMoney = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** Recomputes every figure the Order Service sent; any disagreement means no invoice. */
export function verifyOrder(o: BillableOrder): void {
  const problems: string[] = [];
  if (o.items.length === 0) problems.push('order has no items');
  o.items.forEach((i, idx) => {
    if (!isMoney(i.unitPrice) || !Number.isInteger(i.quantity) || i.quantity < 1) problems.push(`items[${idx}]: invalid price or quantity`);
    else if (i.lineTotal !== i.unitPrice * i.quantity) problems.push(`items[${idx}]: lineTotal ${i.lineTotal} ≠ ${i.unitPrice} × ${i.quantity}`);
  });
  const sum = o.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  if (sum !== o.subtotal) problems.push(`subtotal ${o.subtotal} ≠ Σ lines ${sum}`);
  if (!isMoney(o.deliveryFee)) problems.push('invalid delivery fee');
  if (o.subtotal + o.deliveryFee !== o.provisionalTotal) problems.push(`provisionalTotal ${o.provisionalTotal} ≠ subtotal + deliveryFee ${o.subtotal + o.deliveryFee}`);
  if (problems.length) throw new SubtotalMismatchError(problems);
}

/** Evaluates a discount code against the items subtotal; returns the applied discount or why not. */
export function evaluateDiscount(
  code: string | undefined,
  discount: IDiscount | null,
  itemsSubtotal: number,
  maxAllowed: number,
  now: Date,
): { discount?: IInvoiceDiscount; rejection?: { code: string; reason: string } } {
  if (!code) return {};
  const reject = (reason: string) => ({ rejection: { code, reason } });
  if (!discount) return reject('UNKNOWN_CODE');
  if (!discount.active) return reject('INACTIVE');
  if ((discount.validFrom && now < discount.validFrom) || (discount.validUntil && now > discount.validUntil)) return reject('EXPIRED');
  if (itemsSubtotal < discount.minItemsSubtotal) return reject(`MIN_SUBTOTAL_NOT_MET (needs ${discount.minItemsSubtotal} paise)`);

  let amount = discount.type === 'percent' ? Math.floor((itemsSubtotal * discount.value) / 100) : discount.value;
  if (discount.maxDiscount !== undefined) amount = Math.min(amount, discount.maxDiscount);
  amount = Math.max(0, Math.min(amount, itemsSubtotal, maxAllowed));
  if (amount === 0) return reject('NO_DISCOUNT_APPLICABLE');
  return { discount: { code: discount.code, description: discount.description, type: discount.type, value: discount.value, amount } };
}

/**
 * finalAmount = subtotal − discountAmount + taxAmount, where subtotal = items + delivery fee and
 * taxAmount = Σ taxLines = 0 for now. Integer paise throughout.
 */
export function computeInvoice(o: BillableOrder, discount: IDiscount | null, opts: { minPayable: number; now: Date }): InvoiceTotals {
  verifyOrder(o);
  const lines: IInvoiceLine[] = o.items.map((i) => ({
    kind: 'item',
    description: i.name,
    menuItemId: i.menuItemId,
    unitPrice: i.unitPrice,
    quantity: i.quantity,
    lineTotal: i.unitPrice * i.quantity,
  }));
  if (o.deliveryFee > 0) lines.push({ kind: 'delivery_fee', description: 'Delivery fee', unitPrice: o.deliveryFee, quantity: 1, lineTotal: o.deliveryFee });

  const itemsSubtotal = o.subtotal;
  const subtotal = itemsSubtotal + o.deliveryFee;
  const maxAllowed = Math.max(0, subtotal - opts.minPayable);
  const { discount: applied, rejection } = evaluateDiscount(o.discountCode, discount, itemsSubtotal, maxAllowed, opts.now);
  const discountAmount = applied?.amount ?? 0;
  const taxLines: ITaxLine[] = []; // taxes intentionally out of scope for now
  const taxAmount = taxLines.reduce((s, t) => s + t.amount, 0);
  return {
    lines,
    itemsSubtotal,
    deliveryFee: o.deliveryFee,
    subtotal,
    discount: applied,
    discountRejection: rejection,
    discountAmount,
    taxLines,
    taxAmount,
    finalAmount: subtotal - discountAmount + taxAmount,
  };
}
