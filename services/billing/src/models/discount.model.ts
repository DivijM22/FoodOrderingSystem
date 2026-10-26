import { Schema, model } from 'mongoose';

/** Promotion configuration (mutable). Invoices snapshot the discount they used, so edits never change issued invoices. */
export interface IDiscount {
  code: string;
  description: string;
  type: 'percent' | 'flat';
  /** percent: 1–100; flat: paise */
  value: number;
  /** Cap for percent discounts (paise). */
  maxDiscount?: number;
  /** Minimum items subtotal (paise) to qualify. */
  minItemsSubtotal: number;
  active: boolean;
  validFrom?: Date;
  validUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const discountSchema = new Schema<IDiscount>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, required: true },
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true, min: 1 },
    maxDiscount: { type: Number, min: 1 },
    minItemsSubtotal: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
    validFrom: Date,
    validUntil: Date,
  },
  { timestamps: true, versionKey: false, collection: 'discounts' },
);

export const DiscountModel = model<IDiscount>('Discount', discountSchema);

export function toPublicDiscount(d: IDiscount) {
  return {
    code: d.code,
    description: d.description,
    type: d.type,
    value: d.value,
    maxDiscount: d.maxDiscount ?? null,
    minItemsSubtotal: d.minItemsSubtotal,
    active: d.active,
    validFrom: d.validFrom ?? null,
    validUntil: d.validUntil ?? null,
  };
}
