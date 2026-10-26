import { DiscountModel, type IDiscount } from '../models/discount.model.js';

/** Sample promotions (fictional). Seeding is idempotent and never overwrites edits. */
export const SEED_DISCOUNTS: Omit<IDiscount, 'createdAt' | 'updatedAt'>[] = [
  { code: 'WELCOME50', description: '₹50 off orders of ₹199 or more', type: 'flat', value: 5000, minItemsSubtotal: 19900, active: true },
  { code: 'FEAST20', description: '20% off orders of ₹499+ (up to ₹150)', type: 'percent', value: 20, maxDiscount: 15000, minItemsSubtotal: 49900, active: true },
  { code: 'FLAT100', description: '₹100 off orders of ₹799 or more', type: 'flat', value: 10000, minItemsSubtotal: 79900, active: true },
  { code: 'MONSOON15', description: '15% off (campaign ended)', type: 'percent', value: 15, minItemsSubtotal: 0, active: true, validUntil: new Date('2026-09-30T23:59:59Z') },
  { code: 'PAUSED25', description: '25% off (paused by admin)', type: 'percent', value: 25, minItemsSubtotal: 0, active: false },
];

export async function seedDiscounts(): Promise<number> {
  await DiscountModel.init();
  const res = await DiscountModel.bulkWrite(
    SEED_DISCOUNTS.map((d) => ({ updateOne: { filter: { code: d.code }, update: { $setOnInsert: d }, upsert: true } })),
    { ordered: false },
  );
  return res.upsertedCount;
}
