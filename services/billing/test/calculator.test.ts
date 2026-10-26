import { describe, expect, it } from 'vitest';
import type { IDiscount } from '../src/models/discount.model.js';
import { computeInvoice, SubtotalMismatchError, type BillableOrder } from '../src/services/calculator.js';

const now = new Date('2026-10-16T12:00:00Z');
const order = (o: Partial<BillableOrder> = {}): BillableOrder => ({
  orderId: 'o1', orderNumber: 'ORD-1', customerId: 'c1', restaurantId: 'r1', restaurantName: 'Spice Route',
  items: [
    { menuItemId: 'm1', name: 'Chicken Dum Biryani', unitPrice: 32900, quantity: 2, lineTotal: 65800 },
    { menuItemId: 'm2', name: 'Raita', unitPrice: 4900, quantity: 1, lineTotal: 4900 },
  ],
  subtotal: 70700, deliveryFee: 0, provisionalTotal: 70700, ...o,
});
const disc = (d: Partial<IDiscount>): IDiscount => ({ code: 'X', description: 'x', type: 'flat', value: 5000, minItemsSubtotal: 0, active: true, createdAt: now, updatedAt: now, ...d });
const calc = (o: BillableOrder, d: IDiscount | null = null) => computeInvoice(o, d, { minPayable: 100, now });

describe('invoice calculation (tax excluded: taxAmount = 0)', () => {
  it('itemises lines and computes finalAmount = subtotal − discount + tax', () => {
    const t = calc(order());
    expect(t.lines).toHaveLength(2);
    expect(t).toMatchObject({ itemsSubtotal: 70700, deliveryFee: 0, subtotal: 70700, discountAmount: 0, taxAmount: 0, taxLines: [], finalAmount: 70700 });
  });

  it('includes the delivery fee as a line inside subtotal', () => {
    const t = calc(order({ items: [{ menuItemId: 'm2', name: 'Raita', unitPrice: 4900, quantity: 1, lineTotal: 4900 }], subtotal: 4900, deliveryFee: 4000, provisionalTotal: 8900 }));
    expect(t.lines.at(-1)).toMatchObject({ kind: 'delivery_fee', lineTotal: 4000 });
    expect(t).toMatchObject({ subtotal: 8900, finalAmount: 8900 });
  });

  it('applies flat and capped percentage discounts on the items subtotal', () => {
    expect(calc(order({ discountCode: 'X' }), disc({ value: 5000 }))).toMatchObject({ discountAmount: 5000, finalAmount: 65700, discount: { code: 'X', amount: 5000 } });
    const pct = calc(order({ discountCode: 'X' }), disc({ type: 'percent', value: 20, maxDiscount: 15000 }));
    expect(pct).toMatchObject({ discountAmount: 14140, finalAmount: 56560 }); // floor(70700 × 20%) = 14140 < cap
    const capped = calc(order({ discountCode: 'X' }), disc({ type: 'percent', value: 50, maxDiscount: 15000 }));
    expect(capped.discountAmount).toBe(15000);
  });

  it('rejects codes that are unknown, inactive, expired or below the minimum — and charges full price', () => {
    expect(calc(order({ discountCode: 'NOPE' }), null)).toMatchObject({ discountAmount: 0, finalAmount: 70700, discountRejection: { code: 'NOPE', reason: 'UNKNOWN_CODE' } });
    expect(calc(order({ discountCode: 'X' }), disc({ active: false })).discountRejection!.reason).toBe('INACTIVE');
    expect(calc(order({ discountCode: 'X' }), disc({ validUntil: new Date('2026-01-01') })).discountRejection!.reason).toBe('EXPIRED');
    expect(calc(order({ discountCode: 'X' }), disc({ minItemsSubtotal: 99900 })).discountRejection!.reason).toMatch(/^MIN_SUBTOTAL_NOT_MET/);
  });

  it('never discounts below the minimum payable amount', () => {
    const t = calc(order({ items: [{ menuItemId: 'm', name: 'Tea', unitPrice: 4000, quantity: 1, lineTotal: 4000 }], subtotal: 4000, provisionalTotal: 4000, discountCode: 'X' }), disc({ value: 10000 }));
    expect(t).toMatchObject({ discountAmount: 3900, finalAmount: 100 });
  });

  it('verifies the order arithmetic and refuses mismatches', () => {
    expect(() => calc(order({ subtotal: 70000 }))).toThrow(SubtotalMismatchError);
    expect(() => calc(order({ provisionalTotal: 99999 }))).toThrow(/provisionalTotal/);
    const bad = order();
    bad.items[0]!.lineTotal = 1;
    expect(() => calc(bad)).toThrow(/lineTotal/);
  });
});
