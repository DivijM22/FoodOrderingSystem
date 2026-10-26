import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface IMenuItem {
  _id: Types.ObjectId;
  restaurantId: Types.ObjectId;
  name: string;
  description: string;
  /** Menu section, e.g. "Starters", "Biryani", "Desserts". */
  category: string;
  /** Integer paise (₹249.00 → 24900). */
  price: number;
  isVeg: boolean;
  isAvailable: boolean;
  isBestseller: boolean;
  spiceLevel: number;
  imageUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const menuItemSchema = new Schema<IMenuItem>(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    category: { type: String, required: true, trim: true },
    price: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'price must be an integer number of paise' },
    },
    isVeg: { type: Boolean, required: true },
    isAvailable: { type: Boolean, default: true },
    isBestseller: { type: Boolean, default: false },
    spiceLevel: { type: Number, min: 0, max: 3, default: 0 },
    imageUrl: { type: String },
  },
  { timestamps: true, versionKey: false },
);

// One dish name per restaurant; also serves "menu for restaurant" queries.
menuItemSchema.index({ restaurantId: 1, name: 1 }, { unique: true });
menuItemSchema.index({ restaurantId: 1, category: 1 });

export type MenuItemDocument = HydratedDocument<IMenuItem>;
export const MenuItemModel = model<IMenuItem>('MenuItem', menuItemSchema);

export function toPublicMenuItem(m: IMenuItem) {
  return {
    id: m._id.toString(),
    restaurantId: m.restaurantId.toString(),
    name: m.name,
    description: m.description,
    category: m.category,
    price: m.price,
    isVeg: m.isVeg,
    isAvailable: m.isAvailable,
    isBestseller: m.isBestseller,
    spiceLevel: m.spiceLevel,
    imageUrl: m.imageUrl ?? null,
    updatedAt: m.updatedAt,
  };
}
